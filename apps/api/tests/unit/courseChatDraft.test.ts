import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: vi.fn(async () => 555) }));
vi.mock("../../src/ai/qaGroupReply.js", () => ({ findQaAnswer: vi.fn(async () => null) }));
vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => null),
  presignGet: vi.fn(),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  deleteObject: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

const answerFromRecipes = vi.fn();
vi.mock("../../src/course/assistant.js", () => ({ answerFromRecipes: (...args: unknown[]) => answerFromRecipes(...args) }));

const isBudgetExceeded = vi.fn(async () => false);
const recordAiCall = vi.fn(async () => undefined);
vi.mock("../../src/ai/dailyBudget.js", () => ({
  isBudgetExceeded: (...args: unknown[]) => isBudgetExceeded(...(args as [])),
  recordAiCall: (...args: unknown[]) => recordAiCall(...(args as [])),
}));

import { draftFromPanel } from "../../src/course/chat.js";
import { courseAdminRouter } from "../../src/course/adminRoutes.js";

/**
 * ЧЕРНОВИК ОТ ИИ В INBOX ВОПРОСОВ («Утро Ширин» §6, волна 2): тот же
 * помощник по рецептам, что отвечает ученице сам, но здесь ничего не
 * отправляет — только текст в поле и пометка, по чему он собран. Бюджет —
 * общий с ботом.
 */

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(courseAdminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const question = {
  id: "q1",
  purchaseId: "p1",
  lessonId: "l7",
  fromStudent: true,
  text: "Можно взять молоко 2,5%?",
  purchase: { contactId: "c1", courseId: "course-1" },
  lesson: { order: 7, title: "Наполеон" },
};

describe("draftFromPanel", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    isBudgetExceeded.mockResolvedValue(false);
    answerFromRecipes.mockReset();
    recordAiCall.mockClear();
    db.model("courseChatMessage").findFirst.mockResolvedValue(question);
  });
  afterEach(restorePrisma);

  it("собирает черновик по рецепту урока, списывает ход ИИ и НЕ пишет в ленту", async () => {
    answerFromRecipes.mockResolvedValue({ text: "Да, 2,5% подойдёт — в рецепте это не критично." });
    const r = await draftFromPanel("q1");
    expect(r).toEqual({ draft: "Да, 2,5% подойдёт — в рецепте это не критично.", source: "по рецепту урока 7 «Наполеон»" });
    expect(answerFromRecipes).toHaveBeenCalledWith("course-1", question.text, "ru", "l7");
    expect(recordAiCall).toHaveBeenCalledWith("c1");
    expect(db.model("courseChatMessage").create).not.toHaveBeenCalled();
    expect(db.model("courseChatMessage").update).not.toHaveBeenCalled();
  });

  it("материала нет — draft:null с причиной, ход не списан", async () => {
    answerFromRecipes.mockResolvedValue({ text: null, reason: "no_material" });
    expect(await draftFromPanel("q1")).toEqual({ draft: null, reason: "no_material" });
    expect(recordAiCall).not.toHaveBeenCalled();
  });

  it("суточный бюджет исчерпан — к модели не ходим", async () => {
    isBudgetExceeded.mockResolvedValue(true);
    expect(await draftFromPanel("q1")).toEqual({ draft: null, reason: "budget" });
    expect(answerFromRecipes).not.toHaveBeenCalled();
  });

  it("вопроса нет или покупка без курса", async () => {
    db.model("courseChatMessage").findFirst.mockResolvedValue(null);
    expect(await draftFromPanel("nope")).toEqual({ draft: null, reason: "not_found" });
    db.model("courseChatMessage").findFirst.mockResolvedValue({ ...question, purchase: { contactId: "c1", courseId: null } });
    expect(await draftFromPanel("q1")).toEqual({ draft: null, reason: "no_course" });
  });

  it("POST /admin/course-chat/:id/draft — черновик с пометкой; без материала — понятная записка", async () => {
    answerFromRecipes.mockResolvedValue({ text: "Черновик" });
    const ok = (await (await fetch(`${base}/admin/course-chat/q1/draft`, { method: "POST" })).json()) as { draft: string; source: string };
    expect(ok).toEqual({ draft: "Черновик", source: "по рецепту урока 7 «Наполеон»" });

    answerFromRecipes.mockResolvedValue({ text: null, reason: "no_material" });
    const res = await fetch(`${base}/admin/course-chat/q1/draft`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ draft: null, reason: "no_material", note: expect.stringMatching(/ответить самой/) });

    db.model("courseChatMessage").findFirst.mockResolvedValue(null);
    expect((await fetch(`${base}/admin/course-chat/zzz/draft`, { method: "POST" })).status).toBe(404);
  });
});
