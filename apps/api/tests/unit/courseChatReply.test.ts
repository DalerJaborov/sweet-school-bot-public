import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: vi.fn(async () => 555) }));
vi.mock("../../src/ai/qaGroupReply.js", () => ({ findQaAnswer: vi.fn(async () => null) }));

import { answerFromPanel, answerFromOwner } from "../../src/course/chat.js";

/**
 * INBOX ВОПРОСОВ В ПАНЕЛИ (05.09.2026): ответ из панели пишется ТЕМ ЖЕ путём,
 * что реплай в Telegram — ученица получает его одинаково.
 */
describe("answerFromPanel", () => {
  let db: PrismaMock;
  const question = { id: "q1", purchaseId: "p1", lessonId: "l1", fromStudent: true, text: "Можно молоко?" };
  beforeEach(() => {
    db = mockPrisma();
    db.model("courseChatMessage").create.mockImplementation(async (args: unknown) => ({
      id: "a1",
      ...(args as { data: Record<string, unknown> }).data,
    }));
  });
  afterEach(restorePrisma);

  it("кладёт ответ Ширин в ленту той же покупки/урока и помечает вопрос прочитанным", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue(question);

    const answer = await answerFromPanel("q1", "Да, 3,2% подойдёт");

    expect(answer).toMatchObject({ id: "a1", purchaseId: "p1", lessonId: "l1", fromStudent: false, byBot: false, text: "Да, 3,2% подойдёт" });
    expect(db.model("courseChatMessage").findFirst).toHaveBeenCalledWith({ where: { id: "q1", fromStudent: true } });
    expect(db.model("courseChatMessage").update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q1" }, data: { readByOwnerAt: expect.any(Date) } })
    );
  });

  it("вопроса нет (или это не вопрос ученицы) — null, ничего не записано", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue(null);
    expect(await answerFromPanel("nope", "текст")).toBeNull();
    expect(db.model("courseChatMessage").create).not.toHaveBeenCalled();
  });

  it("реплай в Telegram и ответ из панели пишут одинаковую запись", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue({ ...question, telegramMsgId: 555 });
    await answerFromOwner(555, "ответ");
    const fromTelegram = db.model("courseChatMessage").create.mock.calls[0][0];
    db.model("courseChatMessage").create.mockClear();
    await answerFromPanel("q1", "ответ");
    const fromPanel = db.model("courseChatMessage").create.mock.calls[0][0];
    expect(fromPanel).toEqual(fromTelegram);
  });
});
