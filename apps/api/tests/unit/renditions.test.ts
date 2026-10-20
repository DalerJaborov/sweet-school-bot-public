import { describe, it, expect } from "vitest";
import { renditionsFor, qualitySide, scaleFilterFor } from "../../src/storage/videoPipeline.js";

describe("renditionsFor — дорожки не выше исходника", () => {
  it("1080p-исходник получает все три, от лучшей к худшей", () => {
    expect(renditionsFor(1080).map((r) => r.name)).toEqual(["1080p", "720p", "480p"]);
  });
  it("4K — тоже три: выше 1080p не делаем", () => {
    expect(renditionsFor(2160).map((r) => r.name)).toEqual(["1080p", "720p", "480p"]);
  });
  it("720p-исходник — без 1080p", () => {
    expect(renditionsFor(720).map((r) => r.name)).toEqual(["720p", "480p"]);
  });
  it("совсем маленькое видео — хотя бы 480p", () => {
    expect(renditionsFor(360).map((r) => r.name)).toEqual(["480p"]);
  });
  it("высота неизвестна — как у телефона, 720p", () => {
    expect(renditionsFor(null).map((r) => r.name)).toEqual(["720p", "480p"]);
  });
});

describe("вертикальное видео: качество — короткая сторона", () => {
  it("720×1280 (уроки школы) — 720p и 480p, а не растянутое 1080p", () => {
    expect(qualitySide({ width: 720, height: 1280 })).toBe(720);
    expect(renditionsFor({ width: 720, height: 1280 }).map((r) => r.name)).toEqual(["720p", "480p"]);
  });
  it("1080×1920 (тизер) — все три", () => {
    expect(renditionsFor({ width: 1080, height: 1920 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p"]);
  });
  it("горизонтальное 1920×1080 — как раньше", () => {
    expect(renditionsFor({ width: 1920, height: 1080 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p"]);
  });
  it("известна только одна сторона — берём её; ничего не известно — null", () => {
    expect(qualitySide({ width: null, height: 480 })).toBe(480);
    expect(qualitySide({ width: null, height: null })).toBeNull();
    expect(renditionsFor({ width: null, height: null }).map((r) => r.name)).toEqual(["720p", "480p"]);
  });
});

describe("scaleFilterFor — рамка дорожки поворачивается вместе с кадром", () => {
  it("720p: для горизонтального 1280×720, для вертикального 720×1280", () => {
    expect(scaleFilterFor({ width: 1280, height: 720 })).toBe(
      "scale=w='if(gt(iw,ih),1280,720)':h='if(gt(iw,ih),720,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
  });
  it("чётность сторон и вписывание без увеличения сохранены", () => {
    const f = scaleFilterFor({ width: 854, height: 480 });
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).toContain("force_divisible_by=2");
  });
});
