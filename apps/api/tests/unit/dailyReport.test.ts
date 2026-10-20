import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: vi.fn(async () => undefined) }));

import { buildReport, learningSummary } from "../../src/dailyReport.js";

/**
 * Вечерняя сводка v2: к деньгам и чекам добавились учёба (начали, дошли до
 * конца, сертификаты), вопросы без ответа, расход Gemini и выручка по каналам.
 * Старые строки остаются на месте и в том же стиле.
 */
const OFFSET = 5 * 3_600_000;
const H = 3_600_000;

describe("Вечерняя сводка v2", () => {
  let db: PrismaMock;
  const now = new Date("2026-09-05T18:00:00Z"); // 23:00 Душанбе

  beforeEach(() => {
    db = mockPrisma();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "aiBudget:global:2026-09-05" ? { key: where.key, value: JSON.stringify({ calls: 412 }) } : null
    );
    db.model("message").findMany.mockResolvedValue([]);
    db.model("delivery").count.mockResolvedValue(0);
    db.model("contact").findMany.mockResolvedValue([]);
    db.model("contact").count.mockResolvedValue(0);
    db.model("offlineSignup").findMany.mockResolvedValue([]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("receiptCheck").findMany.mockResolvedValue([]);
    db.model("purchase").count.mockResolvedValue(0);
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("progress").findMany.mockResolvedValue([]);
    db.model("certificate").count.mockResolvedValue(0);
    db.model("courseChatMessage").count.mockResolvedValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    restorePrisma();
  });

  it("learningSummary: считает по окну дня, «дошли до конца» — только чей последний урок сегодня", async () => {
    const range = { gte: new Date(now.getTime() - 18 * H), lte: now };
    db.model("purchase").count.mockResolvedValue(3);
    db.model("certificate").count.mockResolvedValue(1);
    db.model("courseChatMessage").count.mockResolvedValue(2);
    db.model("purchase").findMany.mockResolvedValue([
      { amount: 70, source: "RECEIPT", contact: { channel: "INSTAGRAM" } },
      { amount: 50, source: "RECEIPT", contact: { channel: "INSTAGRAM" } },
      { amount: 70, source: "RECEIPT", contact: { channel: "WEB" } },
    ]);
    // Две покупки с завершением в окне: у одной последний урок закрыт вчера.
    db.model("progress").findMany
      .mockResolvedValueOnce([
        { purchaseId: "p1", purchase: { contactId: "a", courseId: "k", courseRef: { title: "21 рецепт" } } },
        { purchaseId: "p2", purchase: { contactId: "b", courseId: "k", courseRef: { title: "21 рецепт" } } },
      ])
      .mockResolvedValueOnce([
        { purchaseId: "p1", lessonId: "l1", completedAt: new Date(now.getTime() - 2 * H) },
        { purchaseId: "p2", lessonId: "l1", completedAt: new Date(now.getTime() - 30 * H) },
      ]);
    db.model("lesson").findMany.mockResolvedValue([{ id: "l1", module: { courseId: "k" } }]);

    const s = await learningSummary(range);
    expect(s).toMatchObject({ started: 3, finished: 1, certificates: 1, unanswered: 2, gemini: { calls: 412, limit: 1000 } });
    expect(s.byChannel).toEqual([
      { channel: "INSTAGRAM", count: 2, sum: 120 },
      { channel: "WEB", count: 1, sum: 70 },
    ]);
  });

  it("текст: старые строки на месте, новые — учёба, вопросы, Gemini, выручка по каналам", async () => {
    db.model("message").findMany.mockResolvedValue([{ contactId: "a", text: "хочу курс", createdAt: now }]);
    db.model("contact").count.mockResolvedValue(1);
    db.model("delivery").count.mockResolvedValue(1);
    db.model("contact").findMany.mockResolvedValue([{ id: "a", receiptChecks: [{ amount: 70 }] }]);
    db.model("purchase").count.mockResolvedValue(2);
    db.model("purchase").findMany.mockResolvedValue([{ amount: 70, source: "RECEIPT", contact: { channel: "INSTAGRAM" } }]);
    db.model("certificate").count.mockResolvedValue(1);
    db.model("courseChatMessage").count.mockResolvedValue(3);

    const text = await buildReport(OFFSET);
    expect(text).toContain("🌙 Итог за 5 сентября");
    expect(text).toContain("💬 Написали — 1 человек");
    expect(text).toContain("🎯 Пришли с комментария под роликом — 1");
    expect(text).toContain("💰 Оплатили онлайн-курс — 1");
    expect(text).toContain("     на 70 сомони");
    expect(text).toContain("     Instagram 70 с. (1)");
    expect(text).toContain("📚 Начали учиться — 2");
    expect(text).not.toContain("🏁"); // до конца сегодня никто не дошёл — строки нет
    expect(text).toContain("🎓 Сертификатов — 1");
    expect(text).toContain("❓ Вопросов учениц без ответа сейчас — 3");
    expect(text).not.toContain("Gemini"); // расход ИИ в сводке владельцу непонятен — только тревога на 80 %
    expect(text).not.toContain("Где бот застрял");
  });

  it("тихий день: учёба есть, Gemini и необязательные строки молчат", async () => {
    const text = await buildReport(OFFSET);
    expect(text).toContain("💰 Оплат сегодня нет");
    expect(text).toContain("📚 Начали учиться — 0");
    expect(text).not.toContain("Gemini");
    expect(text).not.toContain("❓");
    expect(text).not.toContain("🎓");
    expect(text).toContain("Сегодня никто не писал.");
  });
});
