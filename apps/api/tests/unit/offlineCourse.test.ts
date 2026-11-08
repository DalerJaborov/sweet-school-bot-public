import { cleanAutomatedReply } from "../../src/ai/replyPolicy.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "INSTAGRAM",
}));

import { maybeSendOfflineCard, offlineCourseCard, offlineCardDefault, offlineCardMessages, offlineFactsLine, OFFLINE_DATE_TBD, DEFAULT_OFFLINE_FACTS } from "../../src/ai/offlineCourse.js";
import type { Contact } from "@prisma/client";

function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { value: values[where.key] } : null;
}

const OCT_3 = { year: 2026, month: 10, day: 3 };

describe("текст карточки", () => {
  it("в заготовке факты из «Цены и даты»: 700, 13:40–16:30, 21 десерт, адрес словами владельца (08.11.2026)", () => {
    for (const lang of ["ru", "tg"] as const) {
      const text = offlineCardDefault(lang, OCT_3);
      expect(text).toContain("700");
      expect(text).toContain("13:40");
      expect(text).toContain("16:30");
      expect(text).toContain("Рудаки 156, Воданасос");
      expect(text).toMatch(/дом Додо Пицца|доми Додо Пицца/);
      expect(text).toMatch(/21 (вид десертов|намуд)/);
      expect(text).not.toMatch(/14:00|17:00|156а|Водонасос|Рудаки 177|20 (видов|намуд)/);
    }
    expect(offlineCardDefault("ru", OCT_3)).toContain("каждый день с 13:40 до 16:30");
    expect(offlineCardDefault("tg", OCT_3)).toContain("аз соати 13:40 ба 16:30");
  });

  it("таджикская карточка — словами владельца, разговорно, без особых букв и тире", () => {
    const tg = offlineCardDefault("tg", OCT_3);
    expect(tg).toContain("Курси ояндамон 3 октябр сар мешавад.");
    expect(tg).toContain("пули продукты наметиен");
    expect(tg).toContain("охирда сертификат мегирен");
    expect(tg).toContain("ном и номер монен, запись мекнем");
    for (const lang of ["ru", "tg"] as const) {
      for (const text of [offlineCardDefault(lang, OCT_3), offlineCardDefault(lang, null)]) {
        expect(text).not.toMatch(/[ҷқӯғҳӣ—–]|\p{Extended_Pictographic}/u);
      }
    }
  });

  it("мест в группе — строка только когда число задано", () => {
    const base = offlineCardDefault("ru", OCT_3);
    expect(base).not.toMatch(/мест/);
    const withSeats = offlineCardDefault("ru", OCT_3, { ...DEFAULT_OFFLINE_FACTS, seats: 8 });
    expect(withSeats).toContain("В группе всего 8 мест");
    expect(offlineCardDefault("tg", OCT_3, { ...DEFAULT_OFFLINE_FACTS, seats: 8 })).toContain("факат 8 чой");
  });

  it("строка фактов для модели: прошедшей даты нет — прямой запрет её называть", () => {
    expect(offlineFactsLine(null, DEFAULT_OFFLINE_FACTS)).toMatch(/уточняется — дату НЕ называй/);
    const line = offlineFactsLine(OCT_3, { ...DEFAULT_OFFLINE_FACTS, price: 800, hours: "10:00–13:00" });
    expect(line).toContain("начало 3 октября");
    expect(line).toContain("800 сомони");
    expect(line).toContain("с 10:00 до 13:00");
  });

  it("дата задана и впереди — «начинается 3 октября» / «3 октябр сар мешавад»", () => {
    expect(offlineCardDefault("ru", OCT_3)).toContain("Следующий курс начинается 3 октября.");
    expect(offlineCardDefault("tg", OCT_3)).toContain("Курси ояндамон 3 октябр сар мешавад.");
  });

  it("даты нет — строка «уточняется», и никакого «Начало»", () => {
    for (const lang of ["ru", "tg"] as const) {
      const text = offlineCardDefault(lang, null);
      expect(text).toContain(OFFLINE_DATE_TBD[lang]);
      expect(text).not.toMatch(/начинается|сар мешавад|октябр/);
    }
  });

  it("три коротких сообщения: когда и сколько / что готовим / где и как записаться", () => {
    for (const lang of ["ru", "tg"] as const) {
      for (const text of [offlineCardDefault(lang, OCT_3), offlineCardDefault(lang, null)]) {
        const messages = offlineCardMessages(text);
        expect(messages).toHaveLength(3);
        // Каждое сообщение — пара коротких фраз, а не простыня.
        for (const m of messages) expect(m.length).toBeLessThan(260);
      }
    }
  });

  it("свой текст из настроек с множеством абзацев — не больше трёх сообщений", () => {
    expect(offlineCardMessages("а\n\nб\n\nв\n\nг\n\nд")).toEqual(["а", "б", "в\n\nг\n\nд"]);
    expect(offlineCardMessages("одной строкой")).toEqual(["одной строкой"]);
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
    expect(await offlineCourseCard("ru")).toContain("начинается 3 октября");
  });

  it("день старта — ещё показываем (по Душанбе, UTC+5), назавтра — уже «уточняется»", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ offlineCourseStartDate: "2026-10-03" }));
    // 2 октября 20:00 UTC = 3 октября 01:00 в Душанбе: набор сегодня.
    vi.setSystemTime(new Date("2026-10-02T20:00:00Z"));
    expect(await offlineCourseCard("ru")).toContain("начинается 3 октября");
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
    // Текст заготовки без пересказа моделью, тремя короткими сообщениями.
    const expected = offlineCardMessages(offlineCardDefault("tg", null)).map((m) => cleanAutomatedReply(m));
    expect(sendText.mock.calls.map((c) => c[1])).toEqual(expected);
    expect(db.model("message").create).toHaveBeenCalledTimes(3);
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
