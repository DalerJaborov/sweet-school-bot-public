import { describe, it, expect } from "vitest";
import { rewriteManifest, offlineUrls } from "../src/course/offline";

/**
 * Переписывание манифеста — самая хрупкая часть офлайна: ошибись здесь, и
 * сохранённый урок либо не найдёт сегменты, либо попросит ключ у сети, которой
 * нет. Поэтому проверяем на настоящем выводе ffmpeg.
 */
const REAL = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://school.example/api/course/lessons/l1/key",IV=0x9f2c
#EXTINF:6.000000,
https://acc.r2.cloudflarestorage.com/bucket/courses/m1/l1/480p/seg_000.ts?X-Amz-Signature=abc
#EXTINF:6.000000,
https://acc.r2.cloudflarestorage.com/bucket/courses/m1/l1/480p/seg_001.ts?X-Amz-Signature=def
#EXTINF:3.480000,
https://acc.r2.cloudflarestorage.com/bucket/courses/m1/l1/480p/seg_002.ts?X-Amz-Signature=ghi
#EXT-X-ENDLIST`;

describe("rewriteManifest", () => {
  const out = rewriteManifest(REAL, "l1");

  it("сегменты нумеруются по порядку и ведут в память телефона", () => {
    expect(out).toContain(offlineUrls.segment("l1", 0));
    expect(out).toContain(offlineUrls.segment("l1", 1));
    expect(out).toContain(offlineUrls.segment("l1", 2));
    expect(out).not.toContain("X-Amz-Signature");
  });

  it("ключ тоже локальный — иначе офлайн просил бы его у сети, которой нет", () => {
    expect(out).toContain(`URI="${offlineUrls.key("l1")}"`);
    expect(out).not.toContain("school.example");
  });

  it("служебные строки сохранены: без них плеер не поймёт длительность и порядок", () => {
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
    expect(out).toContain("#EXTINF:3.480000,");
    expect(out).toContain("#EXT-X-ENDLIST");
    expect(out).toContain("IV=0x9f2c");
  });

  it("число строк не меняется — плеер читает манифест построчно", () => {
    expect(out.split("\n")).toHaveLength(REAL.split("\n").length);
  });

  it("нумерация у каждого урока своя", () => {
    const other = rewriteManifest(REAL, "l2");
    expect(other).toContain(offlineUrls.segment("l2", 0));
    expect(other).not.toContain(offlineUrls.segment("l1", 0));
  });
});
