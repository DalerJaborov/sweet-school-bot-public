import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — скрипт на чистом ESM без типов.
import { buildBanners } from "../../scripts/render-promo-banners.mjs";

type Lang = { eyebrow: string; title: string; lead: string; chips: string[] };
type Banner = { file: string; photos: string[]; ru: Lang; tg: Lang };
const banners: Banner[] = buildBanners();
const texts = (b: Banner, l: "ru" | "tg") => [b[l].eyebrow, b[l].title, b[l].lead, ...b[l].chips].join(" | ");

describe("баннеры WhatsApp и Instagram", () => {
  it("три курса, у каждого свой файл", () => {
    expect(banners.map((b) => b.file)).toEqual(["banner-online-70", "banner-online-50", "banner-offline"]);
  });
  it("фото настоящие — лежат в public/img/desserts", () => {
    for (const b of banners) {
      expect(b.photos).toHaveLength(4);
      for (const p of b.photos) {
        expect(fs.existsSync(path.join(__dirname, "../../public/img/desserts", `${p}.webp`))).toBe(true);
      }
    }
  });
  it("нет цен, дат, слова «школа», смайликов и неподставленных шаблонов", () => {
    for (const b of banners) {
      for (const l of ["ru", "tg"] as const) {
        const t = texts(b, l);
        expect(t).not.toMatch(/сомон|\bсом\b|TJS|нарх|школ|\{\{|undefined/iu);
        expect(t).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
        expect(b[l].chips.length).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it("не выдуманы отзывы и обещания: нет «отзыв», «гарантир», «%», «лучш»", () => {
    for (const b of banners) {
      for (const l of ["ru", "tg"] as const) expect(texts(b, l)).not.toMatch(/отзыв|гарантир|%|лучш/iu);
    }
  });
  it("таджикская версия отличается от русской", () => {
    for (const b of banners) expect(b.tg.lead).not.toBe(b.ru.lead);
  });
});
