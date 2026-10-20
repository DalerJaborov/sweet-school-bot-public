import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LESSON_COVER, renderLessonCover, renderStoryCover, STORY_COVER } from "../../src/storage/coverArt";

/** Однотонный «кадр» вертикального тизера — как из телефона, без EXIF. */
async function solidFrame(width = 360, height = 640): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 60 } } })
    .jpeg()
    .toBuffer();
}

describe("coverArt", () => {
  it("рендерит обложку 1280×720 как непустой JPEG", async () => {
    const out = await renderLessonCover({
      frame: await solidFrame(),
      number: 3,
      title: "Творожный пирог",
      durationMin: 24,
      lang: "ru",
    });
    expect(out.length).toBeGreaterThan(1000);
    // Магические байты JPEG: FF D8 ... FF D9.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(LESSON_COVER.width);
    expect(meta.height).toBe(LESSON_COVER.height);
  });

  it("рендерит сторис 1080×1920 с таджикским названием и длинным заголовком", async () => {
    const out = await renderStoryCover({
      frame: await solidFrame(1920, 1080),
      number: 15,
      title: "Тути фаранг дар шоколад ӣӯҳқҷғ — чизкейк «Дубайский шоколад» бо фисташка",
      durationMin: 41,
      lang: "tg",
    });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(STORY_COVER.width);
    expect(meta.height).toBe(STORY_COVER.height);
  });

  it("обложка не однотонная — оверлей действительно наложен", async () => {
    const out = await renderLessonCover({
      frame: await solidFrame(),
      number: 1,
      title: "Эклеры",
      durationMin: 12,
      lang: "ru",
    });
    const stats = await sharp(out).stats();
    // У чистого однотонного кадра stdev каналов ≈ 0; градиент и текст дают разброс.
    expect(stats.channels[0].stdev).toBeGreaterThan(5);
  });
});
