import { describe, it, expect } from "vitest";
import { renditionsFor, qualitySide, scaleFilterFor } from "../../src/storage/videoPipeline.js";

describe("renditionsFor — дорожки не выше исходника", () => {
  it("1080p-исходник получает все пять, от лучшей к худшей", () => {
    expect(renditionsFor(1080).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p", "240p"]);
  });
  it("4K — тоже пять: выше 1080p не делаем", () => {
    expect(renditionsFor(2160).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p", "240p"]);
  });
  it("720p-исходник — без 1080p", () => {
    expect(renditionsFor(720).map((r) => r.name)).toEqual(["720p", "480p", "360p", "240p"]);
  });
  it("совсем маленькое видео — хотя бы 480p (офлайн), 360p и 240p", () => {
    expect(renditionsFor(360).map((r) => r.name)).toEqual(["480p", "360p", "240p"]);
  });
  it("высота неизвестна — как у телефона, 720p", () => {
    expect(renditionsFor(null).map((r) => r.name)).toEqual(["720p", "480p", "360p", "240p"]);
  });
});

describe("вертикальное видео: качество — короткая сторона", () => {
  it("720×1280 (уроки школы) — 720p, 480p и лёгкие, а не растянутое 1080p", () => {
    expect(qualitySide({ width: 720, height: 1280 })).toBe(720);
    expect(renditionsFor({ width: 720, height: 1280 }).map((r) => r.name)).toEqual(["720p", "480p", "360p", "240p"]);
  });
  it("1080×1920 (тизер) — все пять", () => {
    expect(renditionsFor({ width: 1080, height: 1920 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p", "240p"]);
  });
  it("горизонтальное 1920×1080 — как раньше", () => {
    expect(renditionsFor({ width: 1920, height: 1080 }).map((r) => r.name)).toEqual(["1080p", "720p", "480p", "360p", "240p"]);
  });
  it("известна только одна сторона — берём её; ничего не известно — null", () => {
    expect(qualitySide({ width: null, height: 480 })).toBe(480);
    expect(qualitySide({ width: null, height: null })).toBeNull();
    expect(renditionsFor({ width: null, height: null }).map((r) => r.name)).toEqual(["720p", "480p", "360p", "240p"]);
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
  it("360p и 240p всегда последние (самые лёгкие), 480p для офлайна на месте", () => {
    for (const src of [2160, 1080, 720, 480, 360, null] as const) {
      const names = renditionsFor(src).map((r) => r.name);
      expect(names.slice(-2)).toEqual(["360p", "240p"]);
      expect(names).toContain("480p");
    }
  });
  it("битрейт 360p заметно ниже 480p — иначе в ней нет смысла", () => {
    const [r480, r360] = renditionsFor(480);
    expect(Number.parseInt(r360.videoBitrate)).toBeLessThan(Number.parseInt(r480.videoBitrate) / 2);
  });
  it("рамка 360p поворачивается для вертикальных уроков", () => {
    const r360 = renditionsFor(720).find((r) => r.name === "360p")!;
    expect(scaleFilterFor(r360)).toBe(
      "scale=w='if(gt(iw,ih),640,360)':h='if(gt(iw,ih),360,640)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
  });
});

describe("renditionsFor — 240p для совсем слабой связи", () => {
  const r240 = () => renditionsFor(720).find((r) => r.name === "240p")!;

  it("вместе со звуком укладывается в 0.35 Мбит/с — вдвое легче 360p", () => {
    const r = r240();
    const total = Number.parseInt(r.videoBitrate) + Number.parseInt(r.audioBitrate);
    expect(total).toBeLessThanOrEqual(350);
    const r360 = renditionsFor(720).find((x) => x.name === "360p")!;
    expect(total * 2).toBeLessThanOrEqual(Number.parseInt(r360.videoBitrate) + Number.parseInt(r360.audioBitrate));
  });
  it("рамка 240×428: вертикальный 720×1280 ложится ровно в 240×426, а не «238p»", () => {
    expect(scaleFilterFor(r240())).toBe(
      "scale=w='if(gt(iw,ih),428,240)':h='if(gt(iw,ih),240,428)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
    // Вписывание в рамку с округлением вниз до чётного — как считает ffmpeg.
    const fit = (iw: number, ih: number, bw: number, bh: number) => {
      const k = Math.min(bw / iw, bh / ih);
      const even = (v: number) => Math.floor(Math.floor(v) / 2) * 2;
      return [even(iw * k), even(ih * k)];
    };
    expect(fit(720, 1280, 240, 428)).toEqual([240, 426]);
    expect(fit(1280, 720, 428, 240)).toEqual([426, 240]);
    // Короткая сторона = подпись в меню плеера (levelQuality) = имя дорожки.
    expect(Math.min(...fit(720, 1280, 240, 428))).toBe(240);
  });
  it("имена всех дорожек годятся для адреса /variant/<имя>", () => {
    for (const r of renditionsFor(2160)) expect(r.name).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
  });
});
