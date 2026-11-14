import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
import type { Contact } from "@prisma/client";

/**
 * Добавка владельца 11.11.2026: фото меню вместо списка, отзывы пачкой, без
 * повторов уже отправленного и не больше 2 картинок меню за ответ.
 */
const sent: { kind: "text" | "image"; value: string }[] = [];
const already = new Set<string>();
vi.mock("../../src/messaging/send.js", () => ({
  sendToContact: vi.fn(async (_c: unknown, text: string) => {
    sent.push({ kind: "text", value: text });
    return `m${sent.length}`;
  }),
  sendImageToContact: vi.fn(async (_c: unknown, url: string) => {
    sent.push({ kind: "image", value: url });
    return `i${sent.length}`;
  }),
  mediaAlreadySent: vi.fn(async (_id: string, url: string) => already.has(url)),
}));

import { sendCourseMenus, maybeSendCourseMenuPhoto, sendOfflineMenuPhoto, MAX_MEDIA_PER_REPLY } from "../../src/ai/menuImages.js";
import { maybeSendTestimonial } from "../../src/ai/testimonials.js";

let db: PrismaMock;
let settings: Record<string, string> = {};
const contact = fakeContact({ testimonialSentAt: null }) as unknown as Contact;
beforeEach(() => {
  sent.length = 0;
  already.clear();
  settings = {};
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async (args: unknown) => {
    const key = (args as { where: { key: string } }).where.key;
    return key in settings ? { key, value: settings[key] } : null;
  });
  db.model("message").findMany.mockResolvedValue([]);
  db.model("contact").updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => restorePrisma());

describe("фото меню", () => {
  it("картинки из одной настройки, не больше двух за ответ", async () => {
    settings.menuMediaUrls = JSON.stringify({
      online70: ["https://x/70a.jpg", "https://x/70b.jpg", "https://x/70c.jpg"],
      online50: ["https://x/50.jpg"],
      offline: [],
    });
    await sendCourseMenus(contact, ["online70", "online50"], "меню");
    expect(sent.filter((s) => s.kind === "image")).toHaveLength(MAX_MEDIA_PER_REPLY);
  });
  it("уже отправленное этому человеку не повторяется", async () => {
    settings.menuMediaUrls = JSON.stringify({ online70: ["https://x/70.jpg"], online50: [], offline: [] });
    already.add("https://x/70.jpg");
    expect(await sendCourseMenus(contact, ["online70"], "меню")).toBe(0);
    expect(sent).toHaveLength(0);
  });
  it("спросили про онлайн-курс — одно фото его меню вдогонку; рубильник выключает", async () => {
    await maybeSendCourseMenuPhoto(contact, "21 рецепт чи дорад?");
    expect(sent.filter((s) => s.kind === "image").map((s) => s.value)).toEqual([
      "https://shirinsweets.online/media/2a63855d-368c-40fc-b642-037a431e4def.jpg",
    ]);
    sent.length = 0;
    settings.menuPhotosEnabled = "false";
    await maybeSendCourseMenuPhoto(contact, "21 рецепт чи дорад?");
    expect(sent).toHaveLength(0);
  });
  it("вопрос не про курс — фото не шлём", async () => {
    await maybeSendCourseMenuPhoto(contact, "рахмат");
    expect(sent).toHaveLength(0);
  });
  it("офлайн — фото «МЕНЮ КУРСА» без подписи (подпись — сама карточка)", async () => {
    await sendOfflineMenuPhoto(contact, "офлайн");
    expect(sent).toEqual([{ kind: "image", value: "https://shirinsweets.online/media/11711421-2fc6-462b-9127-ec74e194ab97.jpg" }]);
  });
});

describe("отзывы пачкой", () => {
  const pool = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, imageUrl: `https://x/t${i}.jpg`, caption: null, lastShownAt: null, createdAt: new Date() }));
  beforeEach(() => {
    db.model("testimonial").findMany.mockResolvedValue(pool);
    db.model("testimonial").updateMany.mockResolvedValue({ count: 1 });
  });
  it("на «рост мегуед?» — 3 отзыва (по умолчанию) и ссылка на актуальные, если задана", async () => {
    settings.testimonialsLinkUrl = "https://www.instagram.com/stories/highlights/1/";
    await maybeSendTestimonial(contact, "Рост мегуед?");
    expect(sent.filter((s) => s.kind === "image")).toHaveLength(3);
    expect(sent.at(-1)?.value).toContain("https://www.instagram.com/stories/highlights/1/");
  });
  it("ссылки нет в настройке — ссылку не придумываем", async () => {
    await maybeSendTestimonial(contact, "покажите отзывы");
    expect(sent.some((s) => s.kind === "text" && /instagram/.test(s.value))).toBe(false);
  });
  it("пачка одна на разговор: отметка уже стоит — ничего", async () => {
    db.model("contact").updateMany.mockResolvedValue({ count: 0 });
    await maybeSendTestimonial(fakeContact({ testimonialSentAt: new Date() }) as unknown as Contact, "сомневаюсь");
    expect(sent).toHaveLength(0);
  });
  it("рубильник testimonialsEnabled=false — ничего; размер пачки не больше 5", async () => {
    settings.testimonialsEnabled = "false";
    await maybeSendTestimonial(contact, "сомневаюсь");
    expect(sent).toHaveLength(0);
    settings.testimonialsEnabled = "true";
    settings.testimonialBatchSize = "50";
    await maybeSendTestimonial(contact, "сомневаюсь");
    expect(sent.filter((s) => s.kind === "image")).toHaveLength(5);
  });
  it("уже отправленный отзыв этому человеку не повторяется", async () => {
    already.add("https://x/t0.jpg");
    await maybeSendTestimonial(contact, "отзыв бошад?");
    expect(sent.filter((s) => s.kind === "image").map((s) => s.value)).not.toContain("https://x/t0.jpg");
  });
});
