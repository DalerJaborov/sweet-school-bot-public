import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg = {
  endpoint: "https://acc.r2.cloudflarestorage.com",
  bucket: "sweet-school",
  accessKeyId: "key",
  secretAccessKey: "secret",
  region: "auto",
  publicBase: "",
};

const getObject = vi.fn();

vi.mock("../../src/storage/s3.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/storage/s3.js")>();
  return {
    ...original,
    storageConfig: vi.fn(async () => cfg),
    getObject: (...args: unknown[]) => getObject(...args),
  };
});

import { masterManifest, variantManifest, offlineSegmentList } from "../../src/course/manifest.js";
import type { Lesson } from "@prisma/client";

const lesson = {
  id: "lesson-1",
  hlsPath: "courses/mod-1/lesson-1/master.m3u8",
  encryptionKey: Buffer.alloc(16).toString("base64"),
} as unknown as Lesson;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/index.m3u8
`;

const VARIANT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="https://old-domain.example/api/course/lessons/lesson-1/key",IV=0x00
#EXTINF:6.000,
seg_000.ts
#EXTINF:6.000,
seg_001.ts
#EXT-X-ENDLIST
`;

const API = "https://school.example/api/course";

describe("masterManifest", () => {
  beforeEach(() => getObject.mockReset());

  it("пути дорожек ведут на наш сервер, а не в бакет", async () => {
    getObject.mockResolvedValue(Buffer.from(MASTER));

    const out = await masterManifest(lesson, API);

    expect(out).toContain(`${API}/lessons/lesson-1/variant/720p`);
    expect(out).toContain(`${API}/lessons/lesson-1/variant/480p`);
    expect(out).not.toContain("720p/index.m3u8");
    // Служебные строки не тронуты — иначе плеер не поймёт качество.
    expect(out).toContain("#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720");
  });

  it("нет манифеста в бакете — null, а не пустая строка", async () => {
    getObject.mockResolvedValue(null);
    expect(await masterManifest(lesson, API)).toBeNull();
  });

  it("видео ещё не транскодировано — null", async () => {
    expect(await masterManifest({ ...lesson, hlsPath: null } as Lesson, API)).toBeNull();
  });
});

describe("variantManifest", () => {
  beforeEach(() => getObject.mockReset());

  it("сегменты подписаны, ключ ведёт на наш сервер", async () => {
    getObject.mockResolvedValue(Buffer.from(VARIANT));

    const out = (await variantManifest(lesson, "480p", API))!;

    expect(out).toContain(`URI="${API}/lessons/lesson-1/key"`);
    expect(out).not.toContain("old-domain.example");
    // Обе строки сегментов стали подписанными ссылками на бакет.
    const segmentLines = out.split("\n").filter((l) => l.startsWith("https://acc.r2."));
    expect(segmentLines).toHaveLength(2);
    expect(segmentLines[0]).toContain("/sweet-school/courses/mod-1/lesson-1/480p/seg_000.ts");
    expect(segmentLines[0]).toContain("X-Amz-Signature=");
    expect(out).toContain("#EXT-X-ENDLIST");
  });

  it("имя дорожки из адреса не пускает к произвольным объектам бакета", async () => {
    getObject.mockResolvedValue(Buffer.from(VARIANT));

    expect(await variantManifest(lesson, "../../secrets", API)).toBeNull();
    expect(await variantManifest(lesson, "a/b", API)).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe("offlineSegmentList", () => {
  beforeEach(() => getObject.mockReset());

  it("отдаёт только сегменты, без служебных строк", async () => {
    getObject.mockResolvedValue(Buffer.from(VARIANT));

    const list = (await offlineSegmentList(lesson, "480p"))!;

    expect(list.urls).toHaveLength(2);
    expect(list.urls.every((u) => u.startsWith("https://acc.r2."))).toBe(true);
    expect(list.urls.some((u) => u.includes("#EXT"))).toBe(false);
  });
});
