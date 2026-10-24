import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => 555);
const findQaAnswer = vi.fn(async () => null as { ownerText: string } | null);

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a) }));
vi.mock("../../src/ai/qaGroupReply.js", () => ({ findQaAnswer: (t: string) => findQaAnswer(t) }));

import { receiveQuestion, answerFromOwner, chatHistory } from "../../src/course/chat.js";
import type { Purchase } from "@prisma/client";

const purchase = { id: "purchase-1", contactId: "contact-1" } as Purchase;

function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { value: values[where.key] } : null;
}

describe("receiveQuestion", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    sendTelegramMessage.mockClear().mockResolvedValue(555);
    findQaAnswer.mockClear().mockResolvedValue(null);
    db.model("courseChatMessage").findMany.mockResolvedValue([]);
    db.model("contact").findUnique.mockResolvedValue({ username: "client", igUserId: "ig-1" });
  });
  afterEach(restorePrisma);

  it("frozen: stores a student question but sends no automatic answer or group notification", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ botFrozen: "true", qaAutoReplyEnabled: "true", telegramBotToken: "token", telegramQaGroupId: "group" }));
    await receiveQuestion(purchase, "Можно заменить сливки?", null, false);
    expect(db.model("courseChatMessage").create).toHaveBeenCalledOnce();
    expect(findQaAnswer).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("автоответ выключен — бот молчит и зовёт Ширин", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ telegramBotToken: "token", telegramOwnerChatId: "chat" })
    );

    await receiveQuestion(purchase, "Можно заменить сливки молоком?", null, false);

    expect(findQaAnswer).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    // Записан только вопрос ученицы, ответа бота нет.
    const created = db.model("courseChatMessage").create.mock.calls as { data: { fromStudent: boolean } }[][];
    expect(created).toHaveLength(1);
    expect(created[0][0].data.fromStudent).toBe(true);
  });

  it("автоответ включён и совпадение найдено — отвечаем её же словами, владельца не дёргаем", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ qaAutoReplyEnabled: "true", telegramBotToken: "token", telegramOwnerChatId: "chat" })
    );
    findQaAnswer.mockResolvedValue({ ownerText: "Да, но крем будет жиже" });

    await receiveQuestion(purchase, "Можно заменить сливки молоком?", null, false);

    const created = db.model("courseChatMessage").create.mock.calls as {
      data: { fromStudent: boolean; byBot?: boolean; text?: string };
    }[][];
    expect(created).toHaveLength(2);
    expect(created[1][0].data).toMatchObject({ fromStudent: false, byBot: true, text: "Да, но крем будет жиже" });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("автоответ включён, но совпадения нет — молчим и зовём Ширин, ничего не сочиняя", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ qaAutoReplyEnabled: "true", telegramBotToken: "token", telegramOwnerChatId: "chat" })
    );
    findQaAnswer.mockResolvedValue(null);

    await receiveQuestion(purchase, "А если духовка газовая?", null, false);

    const created = db.model("courseChatMessage").create.mock.calls;
    expect(created).toHaveLength(1);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("сбой поиска в архиве не съедает вопрос — он всё равно уходит владельцу", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ qaAutoReplyEnabled: "true", telegramBotToken: "token", telegramOwnerChatId: "chat" })
    );
    findQaAnswer.mockRejectedValue(new Error("Gemini недоступен"));

    await receiveQuestion(purchase, "Вопрос", null, false);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("Telegram не настроен — вопрос всё равно сохранён, владелец увидит в панели", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);

    await receiveQuestion(purchase, "Вопрос", null, false);

    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("courseChatMessage").create).toHaveBeenCalledTimes(1);
  });

  it("message_id запоминается — по нему ответ реплаем вернётся этой ученице", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ telegramBotToken: "token", telegramOwnerChatId: "chat" })
    );
    db.model("courseChatMessage").findFirst.mockResolvedValue({ id: "msg-1" });

    await receiveQuestion(purchase, "Вопрос", null, false);

    expect(db.model("courseChatMessage").update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { telegramMsgId: 555 },
    });
  });
});

describe("answerFromOwner", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("реплай на чужое сообщение — не наш случай, отдаём false", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue(null);

    expect(await answerFromOwner(999, "ответ")).toBe(false);
    expect(db.model("courseChatMessage").create).not.toHaveBeenCalled();
  });

  it("реплай на вопрос с платформы кладёт ответ в ленту ученицы и гасит красную точку", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue({
      id: "q1",
      purchaseId: "purchase-1",
      lessonId: "lesson-1",
    });

    expect(await answerFromOwner(555, "Да, можно")).toBe(true);
    expect(db.model("courseChatMessage").create).toHaveBeenCalledWith({
      data: {
        purchaseId: "purchase-1",
        lessonId: "lesson-1",
        fromStudent: false,
        text: "Да, можно",
        byBot: false,
      },
    });
    expect(db.model("courseChatMessage").update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "q1" }, data: { readByOwnerAt: expect.any(Date) } })
    );
  });
});

describe("chatHistory", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("возвращает ленту в хронологическом порядке, хотя из базы берёт свежие", async () => {
    db.model("courseChatMessage").findMany.mockResolvedValue([
      { id: "new", createdAt: new Date("2026-09-03T12:00:00Z") },
      { id: "old", createdAt: new Date("2026-09-03T10:00:00Z") },
    ]);

    const rows = await chatHistory("purchase-1");

    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });
});
