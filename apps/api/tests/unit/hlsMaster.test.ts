import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  decryptSegment,
  looksLikeMpegTs,
  mergeMaster,
  missingVariants,
  parseKeyTags,
  parseMaster,
  parseVariant,
  segmentIv,
} from "../../src/storage/hlsMaster.js";

/** Мастер-плейлист старого урока — как его пишет ffmpeg (16.11.2026, прод). */
const OLD_MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=3440000,RESOLUTION=720x1280,CODECS="avc1.4d401f,mp4a.40.2"',
  "720p/index.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=1430000,RESOLUTION=480x852,CODECS="avc1.4d401f,mp4a.40.2"',
  "480p/index.m3u8",
  "",
].join("\n");

/** master.m3u8, который ffmpeg пишет при кодировании только лёгких дорожек. */
const LOW_MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=680000,RESOLUTION=360x640,CODECS="avc1.4d401e,mp4a.40.2"',
  "360p/index.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=330000,RESOLUTION=240x426,CODECS="avc1.4d4015,mp4a.40.2"',
  "240p/index.m3u8",
  "",
].join("\n");

describe("parseMaster", () => {
  it("дорожки по порядку, с именем и битрейтом", () => {
    const e = parseMaster(OLD_MASTER);
    expect(e.map((x) => [x.name, x.bandwidth])).toEqual([
      ["720p", 3440000],
      ["480p", 1430000],
    ]);
  });
  it("не мастер-плейлист — ошибка, а не тихий пустой список", () => {
    expect(() => parseMaster("hello")).toThrow(/EXTM3U/);
    expect(() => parseMaster("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n")).toThrow(/нет пути/);
  });
  it("CRLF понимается так же", () => {
    expect(parseMaster(OLD_MASTER.replace(/\n/g, "\r\n")).map((x) => x.name)).toEqual(["720p", "480p"]);
  });
});

describe("mergeMaster — дописать лёгкие дорожки, старое не трогать", () => {
  it("старые строки остаются байт в байт и первыми, новые — в конце", () => {
    const merged = mergeMaster(OLD_MASTER, LOW_MASTER);
    expect(merged.startsWith(OLD_MASTER.trimEnd())).toBe(true);
    expect(parseMaster(merged).map((x) => x.name)).toEqual(["720p", "480p", "360p", "240p"]);
    expect(merged).toContain('RESOLUTION=240x426,CODECS="avc1.4d4015,mp4a.40.2"\n240p/index.m3u8\n');
    expect(merged.endsWith("\n")).toBe(true);
  });
  it("идемпотентно: второй раз файл не меняется ни на байт", () => {
    const once = mergeMaster(OLD_MASTER, LOW_MASTER);
    expect(mergeMaster(once, LOW_MASTER)).toBe(once);
  });
  it("дописывает только недостающее: 360p уже был — добавится лишь 240p", () => {
    const with360 = mergeMaster(OLD_MASTER, LOW_MASTER.split("\n\n#EXT-X-STREAM-INF:BANDWIDTH=330000")[0] + "\n");
    expect(parseMaster(with360).map((x) => x.name)).toEqual(["720p", "480p", "360p"]);
    const full = mergeMaster(with360, LOW_MASTER);
    expect(parseMaster(full).map((x) => x.name)).toEqual(["720p", "480p", "360p", "240p"]);
    expect(full.match(/360p\/index\.m3u8/g)).toHaveLength(1);
  });
  it("новые дорожки идут от тяжёлой к лёгкой, даже если ffmpeg написал иначе", () => {
    const reversed = [
      "#EXTM3U",
      LOW_MASTER.split("\n").slice(5, 7).join("\n"),
      LOW_MASTER.split("\n").slice(2, 4).join("\n"),
      "",
    ].join("\n");
    expect(parseMaster(mergeMaster(OLD_MASTER, reversed)).map((x) => x.name)).toEqual(["720p", "480p", "360p", "240p"]);
  });
  it("CRLF старого файла сохраняется", () => {
    const crlf = OLD_MASTER.replace(/\n/g, "\r\n");
    const merged = mergeMaster(crlf, LOW_MASTER);
    expect(merged.startsWith(crlf.trimEnd())).toBe(true);
    expect(merged).not.toMatch(/[^\r]\n/);
  });
  it("пустой или чужой master не переписываем", () => {
    expect(() => mergeMaster("#EXTM3U\n", LOW_MASTER)).toThrow(/ни одной дорожки/);
    const evil = LOW_MASTER.replace("240p/index.m3u8", "../../other/index.m3u8");
    expect(() => mergeMaster(OLD_MASTER, evil)).toThrow(/неожиданный путь/);
    const noBw = LOW_MASTER.replace("BANDWIDTH=330000,", "");
    expect(() => mergeMaster(OLD_MASTER, noBw)).toThrow(/BANDWIDTH/);
  });
});

describe("missingVariants", () => {
  it("старому уроку не хватает обеих, новому — ничего", () => {
    expect(missingVariants(OLD_MASTER, ["360p", "240p"])).toEqual(["360p", "240p"]);
    expect(missingVariants(mergeMaster(OLD_MASTER, LOW_MASTER), ["360p", "240p"])).toEqual([]);
  });
});

describe("ключ и сегменты дорожки", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://school.example/api/course/lessons/L1/key",IV=0x00112233445566778899AABBCCDDEEFF',
    "#EXTINF:6.000000,",
    "seg_000.ts",
    "#EXTINF:3.500000,",
    "seg_001.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");

  it("URI и IV читаются из #EXT-X-KEY (IV — без 0x, строчными)", () => {
    expect(parseKeyTags(playlist)).toEqual([
      {
        method: "AES-128",
        uri: "https://school.example/api/course/lessons/L1/key",
        iv: "00112233445566778899aabbccddeeff",
      },
    ]);
  });
  it("сегменты, длительность и конец плейлиста", () => {
    expect(parseVariant(playlist)).toEqual({
      mediaSequence: 0,
      segments: ["seg_000.ts", "seg_001.ts"],
      durationSec: 9.5,
      ended: true,
    });
  });
  it("без IV в теге IV = номер сегмента (как требует HLS)", () => {
    const iv = segmentIv({ method: "AES-128", uri: "x", iv: null }, 5, 2);
    expect(iv.toString("hex")).toBe("00000000000000000000000000000007");
  });
  it("расшифровка тем же ключом даёт MPEG-TS, чужим — нет", () => {
    const key = crypto.randomBytes(16);
    const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const ts = Buffer.alloc(188 * 4);
    for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
    const c = crypto.createCipheriv("aes-128-cbc", key, iv);
    const enc = Buffer.concat([c.update(ts), c.final()]);
    expect(looksLikeMpegTs(decryptSegment(enc, key, iv))).toBe(true);
    const wrong = crypto.randomBytes(16);
    let ok = false;
    try {
      ok = looksLikeMpegTs(decryptSegment(enc, wrong, iv));
    } catch {
      ok = false;
    }
    expect(ok).toBe(false);
  });
});
