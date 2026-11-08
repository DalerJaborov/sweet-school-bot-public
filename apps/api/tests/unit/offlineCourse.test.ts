import { cleanAutomatedReply } from "../../src/ai/replyPolicy.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "INSTAGRAM",
}));

import { maybeSendOfflineCard, offlineCourseCard, offlineCardDefault, offlineFactsLine, OFFLINE_DATE_TBD, DEFAULT_OFFLINE_FACTS } from "../../src/ai/offlineCourse.js";
import type { Contact } from "@prisma/client";

function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { value: values[where.key] } : null;
}

const OCT_3 = { year: 2026, month: 10, day: 3 };

describe("текст карточки", () => {
  it("в заготовке факты сайта: 700, 13:40–16:30, 21 десерт, Воданасос, Рудаки 177 (08.11.2026)", () => {
    for (const lang of ["ru", "tg"] as const) {
      const text = offlineCardDefault(lang, OCT_3);
      expect(text).toContain("700");
      expect(text).toContain("13:40");
      expect(text).toContain("16:30");
      expect(text).toContain("Воданасос");
      expect(text).toMatch(/Рудаки 177|Рӯдакӣ 177/);
      expect(text).toMatch(/21 (вид десертов|намуд)/);
      expect(text).not.toMatch(/14:00|17:00|156а|Додо|Водонасос|20 (видов|намуд)/);
    }
    expect(offlineCardDefault("ru", OCT_3)).toContain("Каждый день с 13:40 до 16:30");
    expect(offlineCardDefault("tg", OCT_3)).toContain("Ҳар рӯз аз 13:40 то 16:30");
  });

  it("мест в группе — строка только когда число задано", () => {
    const base = offlineCardDefault("ru", OCT_3);
    expect(base).not.toMatch(/мест/);
    const withSeats = offlineCardDefault("ru", OCT_3, { ...DEFAULT_OFFLINE_FACTS, seats: 8 });
    expect(withSeats).toContain("В группе всего 8 мест");
    expect(offlineCardDefault("tg", OCT_3, { ...DEFAULT_OFFLINE_FACTS, seats: 8 })).toContain("ҳамагӣ 8 ҷой");
  });

  it("строка фактов для модели: прошедшей даты нет — прямой запрет её называть", () => {
    expect(offlineFactsLine(null, DEFAULT_OFFLINE_FACTS)).toMatch(/уточняется — дату НЕ называй/);
    const line = offlineFactsLine(OCT_3, { ...DEFAULT_OFFLINE_FACTS, price: 800, hours: "10:00–13:00" });
    expect(line).toContain("начало 3 октября");
    expect(line).toContain("800 сомони");
    expect(line).toContain("с 10:00 до 13:00");
  });

  it("дата задана и впереди — «Начало: 3 октября» / «Оғоз: 3 октябр»", () => {
    expect(offlineCardDefault("ru", OCT_3)).toContain("📅 Начало: 3 октября");
    expect(offlineCardDefault("tg", OCT_3)).toContain("📅 Оғоз: 3 октябр");
  });

  it("даты нет — строка «уточняется», и никакого «Начало»", () => {
    for (const lang of ["ru", "tg"] as const) {
      const text = offlineCardDefault(lang, null);
      expect(text).toContain(OFFLINE_DATE_TBD[lang]);
      expect(text).not.toMatch(/Начало|Оғоз|октябр/);
    }
  });

  it("строки короткие и разделены на блоки — чтобы читалось с телефона за секунду", () => {
    for (const lang of ["ru", "tg"] as const) {
      for (const text of [offlineCardDefault(lang, OCT_3), offlineCardDefault(lang, null)]) {
        const lines = text.split("\n").filter((l) => l.trim());
        // Ни одной строки-простыни: глаз должен ловить одну мысль за раз.
        expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(70);
        // Пустые строки разделяют смысловые блоки.
        expect(text.split("\n\n").length).toBeGreaterThan(3);
      }
    }
  });
});

describe("offlineCourseCard", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(fakeContact());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    restorePrisma();
  });

  it("таджикская и русская версии берутся из разных настроек", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ offlineCourseInfoTg: "матни тоҷикӣ", offlineCourseInfo: "русский текст" })
    );

    expect(await offlineCourseCard("tg")).toBe("матни тоҷикӣ");
    expect(await offlineCourseCard("ru")).toBe("русский текст");
  });

  it("настройка текста пуста, дата набора впереди — заготовка с этой датой", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ offlineCourseStartDate: "2026-10-03" }));

    expect(await offlineCourseCard("tg")).toBe(offlineCardDefault("tg", OCT_3));
    expect(await offlineCourseCard("ru")).toContain("Начало: 3 октября");
  });

  it("день старта — ещё показываем (по Душанбе, UTC+5), назавтра — уже «уточняется»", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ offlineCourseStartDate: "2026-10-03" }));
    // 2 октября 20:00 UTC = 3 октября 01:00 в Душанбе: набор сегодня.
    vi.setSystemTime(new Date("2026-10-02T20:00:00Z"));
    expect(await offlineCourseCard("ru")).toContain("Начало: 3 октября");
    // 3 октября 19:30 UTC = 4 октября 00:30 в Душанбе: набор прошёл.
    vi.setSystemTime(new Date("2026-10-03T19:30:00Z"));
    const text = await offlineCourseCard("ru");
    expect(text).toContain(OFFLINE_DATE_TBD.ru);
    expect(text).not.toContain("3 октября");
  });

  it("дата не задана — «уточняется» на обоих языках", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    expect(await offlineCourseCard("ru")).toContain(OFFLINE_DATE_TBD.ru);
    expect(await offlineCourseCard("tg")).toContain(OFFLINE_DATE_TBD.tg);
  });

  it("англоязычной клиентке — русская версия: очный курс идёт в Душанбе", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    expect(await offlineCourseCard("en")).toBe(offlineCardDefault("ru", null));
  });
});

describe("maybeSendOfflineCard", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(fakeContact());
    sendText.mockClear().mockResolvedValue("mid-1");
    db.model("setting").findUnique.mockResolvedValue(null);
  });
  afterEach(restorePrisma);

  it("первый раз: карточка уходит дословно и записывается в историю", async () => {
    const contact = fakeContact({ offlineInfoSentAt: null }) as unknown as Contact;
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });

    const sent = await maybeSendOfflineCard(contact, "сабти ном мехоҳам");

    expect(sent).toBe(true);
    // Текст заготовки без пересказа моделью; единая политика убирает emoji.
    expect(sendText.mock.calls[0][1]).toBe(cleanAutomatedReply(offlineCardDefault("tg", null)));
    expect(db.model("message").create).toHaveBeenCalledTimes(1);
  });

  it("второй раз молчим — не заваливаем той же простынёй", async () => {
    const contact = fakeContact({ offlineInfoSentAt: new Date() }) as unknown as Contact;

    expect(await maybeSendOfflineCard(contact, "запишите меня")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("гонка двух сообщений подряд: карточка уходит один раз", async () => {
    const contact = fakeContact({ offlineInfoSentAt: null }) as unknown as Contact;
    // Отметку успел поставить параллельный вызов.
    db.model("contact").updateMany.mockResolvedValue({ count: 0 });

    expect(await maybeSendOfflineCard(contact, "запишите")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("отправка не удалась — отметка снимается, человек получит карточку позже", async () => {
    const contact = fakeContact({ offlineInfoSentAt: null }) as unknown as Contact;
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    sendText.mockRejectedValue(new Error("окно Instagram закрыто"));

    expect(await maybeSendOfflineCard(contact, "запишите")).toBe(false);
    expect(db.model("contact").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { offlineInfoSentAt: null } })
    );
  });
});
