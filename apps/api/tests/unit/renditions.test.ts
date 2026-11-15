import { describe, it, expect } from "vitest";
import { renditionsFor, qualitySide, scaleFilterFor } from "../../src/storage/videoPipeline.js";

describe("renditionsFor — дорожки не выше исходника", () => {
  it("1080p-исходник получает все четыре, от лучшей к худшей", () => {
    expect(renditionsFor(1080).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p"]);
  });
  it("4K — тоже четыре: выше 1080p не делаем", () => {
    expect(renditionsFor(2160).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p"]);
  });
  it("720p-исходник — без 1080p", () => {
    expect(renditionsFor(720).map((r) => r.name)).toEqual(["720p", "480p", "360p"]);
  });
  it("совсем маленькое видео — хотя бы 480p (офлайн) и 360p", () => {
    expect(renditionsFor(360).map((r) => r.name)).toEqual(["480p", "360p"]);
  });
  it("высота неизвестна — как у телефона, 720p", () => {
    expect(renditionsFor(null).map((r) => r.name)).toEqual(["720p", "480p", "360p"]);
  });
});

describe("вертикальное видео: качество — короткая сторона", () => {
  it("720×1280 (уроки школы) — 720p и 480p, а не растянутое 1080p", () => {
    expect(qualitySide({ width: 720, height: 1280 })).toBe(720);
    expect(renditionsFor({ width: 720, height: 1280 }).map((r) => r.name)).toEqual(["720p", "480p", "360p"]);
  });
  it("1080×1920 (тизер) — все четыре", () => {
    expect(renditionsFor({ width: 1080, height: 1920 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p"]);
  });
  it("горизонтальное 1920×1080 — как раньше", () => {
    expect(renditionsFor({ width: 1920, height: 1080 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p"]);
  });
  it("известна только одна сторона — берём её; ничего не известно — null", () => {
    expect(qualitySide({ width: null, height: 480 })).toBe(480);
    expect(qualitySide({ width: null, height: null })).toBeNull();
    expect(renditionsFor({ width: null, height: null }).map((r) => r.name)).toEqual(["720p", "480p", "360p"]);
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

describe("renditionsFor — лёгкая дорожка 360p для слабой связи", () => {
  it("360p всегда последняя (самая лёгкая), 480p для офлайна на месте", () => {
    for (const src of [2160, 1080, 720, 480, 360, null] as const) {
      const names = renditionsFor(src).map((r) => r.name);
      expect(names[names.length - 1]).toBe("360p");
      expect(names).toContain("480p");
    }
  });
  it("битрейт 360p заметно ниже 480p — иначе в ней нет смысла", () => {
    const [r480, r360] = renditionsFor(480);
    expect(Number.parseInt(r360.videoBitrate)).toBeLessThan(Number.parseInt(r480.videoBitrate) / 2);
  });
  it("рамка 360p поворачивается для вертикальных уроков", () => {
    const r360 = renditionsFor(720).at(-1)!;
    expect(scaleFilterFor(r360)).toBe(
      "scale=w='if(gt(iw,ih),640,360)':h='if(gt(iw,ih),360,640)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
  });
});
