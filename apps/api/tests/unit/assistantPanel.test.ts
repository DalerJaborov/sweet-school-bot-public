import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * «СПРОСИТЬ ПОМОЩНИЦУ» (§21): модель — диспетчер над закрытым набором
 * инструментов. Проверяем: вызов инструмента исполняется и попадает в
 * источники; круги инструментов ограничены; бюджет → 429 с ответом без ИИ;
 * неизвестный инструмент пропускается; «кто не открыл» считается без модели.
 */
const generateWithFallback = vi.fn();
vi.mock("../../src/gemini.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gemini.js")>();
  return { ...actual, generateWithFallback: (...a: unknown[]) => generateWithFallback(...a) };
});

const isBudgetExceeded = vi.fn(async () => false);
const recordAiCall = vi.fn(async () => undefined);
vi.mock("../../src/ai/dailyBudget.js", () => ({
  isBudgetExceeded: (...args: unknown[]) => isBudgetExceeded(...(args as [])),
  recordAiCall: (...args: unknown[]) => recordAiCall(...(args as [])),
}));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key-1"]) }));
vi.mock("../../src/ai/aiLog.js", () => ({ logAiCall: vi.fn(async () => undefined) }));
vi.mock("../../src/course/delivery.js", () => ({ deliveryMode: vi.fn(async () => "platform") }));
vi.mock("../../src/course/assistant.js", () => ({ answerFromRecipes: vi.fn(async () => ({ text: "Сливки 33% — как в рецепте." })) }));

const buildRevenue = vi.fn();
vi.mock("../../src/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/metrics.js")>();
  return { ...actual, buildRevenue: (...a: unknown[]) => buildRevenue(...a) };
});
vi.mock("../../src/today.js", () => ({ todaySnapshot: vi.fn(async () => ({ money: { yesterday: 0, week: 0, prevWeek: 0, salesYesterday: 0, salesWeek: 0 }, pendingReceipts: 0, unansweredQuestions: 0, notOpened: 0, system: { gemini: { calls: 0, limit: 1000 } } })) }));

import { ask, assistantRouter, resetHourlyCap, toolDeclarations, MAX_TOOL_ROUNDS, PANEL_CONTACT_ID } from "../../src/assistantPanel.js";

const revenue = {
  days: 7,
  total: 240,
  count: 4,
  byCourse: [{ key: "COURSE_70", title: "21 рецепт", sum: 140, count: 2 }, { key: "COURSE_50", title: "12 рецептов", sum: 100, count: 2 }],
  byChannel: [{ key: "INSTAGRAM", title: "Instagram", sum: 240, count: 4 }],
  timeToPay: { medianHours: 3, averageHours: 4, sample: 4 },
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  text: null,
  model: "m",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
  functionCalls: [{ name, args, thoughtSignature: "sig-1" }],
});
const say = (text: string) => ({ text, model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(assistantRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("assistantPanel", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("setting").findUnique.mockResolvedValue(null);
    generateWithFallback.mockReset();
    buildRevenue.mockReset().mockResolvedValue(revenue);
    isBudgetExceeded.mockResolvedValue(false);
    recordAiCall.mockClear();
    resetHourlyCap();
  });
  afterEach(restorePrisma);

  it("набор инструментов закрыт и виден владельцу", async () => {
    expect(toolDeclarations().map((t) => t.name)).toEqual(["money", "funnel", "notOpened", "student", "unansweredQuestions", "draftReply", "today"]);
    const r = (await (await fetch(`${base}/admin/assistant/tools`)).json()) as { tools: { name: string }[] };
    expect(r.tools).toHaveLength(7);
  });

  it("(1) functionCall money исполняется, цифры — в источниках, модель получает functionResponse", async () => {
    generateWithFallback.mockResolvedValueOnce(call("money", { days: 7 })).mockResolvedValueOnce(say("За неделю продали на 240 с. — 4 оплаты."));
    const out = await ask({ question: "сколько продали на этой неделе?" });
    expect(out.status).toBe(200);
    const body = out.body as { answer: string; sources: { tool: string; args: unknown; summary: string; data: { total: number } }[] };
    expect(body.answer).toMatch(/240/);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ tool: "money", args: { days: 7 }, data: { total: 240, count: 4 } });
    expect(body.sources[0].summary).toMatch(/240 с\./);
    expect(buildRevenue).toHaveBeenCalledWith(7);

    // Второй вызов модели несёт объявления инструментов и ответ инструмента.
    const [, , build] = generateWithFallback.mock.calls[1] as [string[], string, (m: string) => string];
    const req = JSON.parse(build("gemini-3.6-flash")) as { tools: unknown[]; contents: { role: string; parts: Record<string, unknown>[] }[] };
    expect(req.tools).toHaveLength(1);
    const last = req.contents.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.parts[0]).toMatchObject({ functionResponse: { name: "money", response: { data: { total: 240 } } } });
    // Gemini 3: вызов инструмента возвращается вместе с thoughtSignature, иначе HTTP 400.
    const modelTurn = req.contents.at(-2)!;
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts[0]).toMatchObject({ functionCall: { name: "money", args: { days: 7 } }, thoughtSignature: "sig-1" });
    // Один ход бюджета на вопрос, а не на каждый круг.
    expect(recordAiCall).toHaveBeenCalledTimes(1);
    expect(recordAiCall).toHaveBeenCalledWith(PANEL_CONTACT_ID);
  });

  it("(2) круги инструментов останавливаются на MAX_TOOL_ROUNDS, последний вызов — без инструментов", async () => {
    generateWithFallback.mockResolvedValue(call("money", { days: 30 }));
    const out = await ask({ question: "деньги" });
    expect(generateWithFallback).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(buildRevenue).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    const [, , build] = generateWithFallback.mock.calls[MAX_TOOL_ROUNDS] as [string[], string, (m: string) => string];
    const req = JSON.parse(build("m")) as { tools?: unknown; toolConfig?: { functionCallingConfig: { mode: string } } };
    expect(req.tools).toBeUndefined();
    expect(req.toolConfig?.functionCallingConfig.mode).toBe("NONE");
    // Модель так и не сформулировала — отдаём сводки посчитанного, а не пустоту.
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ fallback: true });
    expect((out.body as { sources: unknown[] }).sources).toHaveLength(MAX_TOOL_ROUNDS);
  });

  it("(3) бюджет исчерпан — 429 и ответ без ИИ для знакомого вопроса", async () => {
    isBudgetExceeded.mockResolvedValue(true);
    const res = await fetch(`${base}/admin/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "сколько продали за неделю?" }) });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; fallback: { answer: string; fallback: boolean; sources: { tool: string }[] } };
    expect(body.error).toMatch(/лимит/);
    expect(body.fallback.answer).toMatch(/240 с\./);
    expect(body.fallback.sources[0].tool).toBe("money");
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(recordAiCall).not.toHaveBeenCalled();
  });

  it("(4) неизвестный инструмент пропускается, ответ модели идёт как есть", async () => {
    generateWithFallback.mockResolvedValueOnce({ ...call("deleteEverything", { all: true }), text: "Удаляю всё." });
    const out = await ask({ question: "удали всех" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ answer: "Удаляю всё.", sources: [] });
    expect(generateWithFallback).toHaveBeenCalledTimes(1);
    expect(buildRevenue).not.toHaveBeenCalled();
  });

  it("(5) «кто не открыл урок» при сбое модели считается без ИИ из notOpened", async () => {
    generateWithFallback.mockResolvedValue({ error: "сеть" });
    db.model("contact").findMany.mockResolvedValue([
      { id: "c1", username: "madina", name: null, igUserId: "111", paidAt: new Date(Date.now() - 3 * 86_400_000) },
      { id: "c2", username: null, name: "Зарина", igUserId: "123456789", paidAt: new Date(Date.now() - 5 * 86_400_000) },
    ]);
    const out = await ask({ question: "кто не открыл урок?" });
    expect(out.status).toBe(200);
    const body = out.body as { answer: string; fallback: boolean; sources: { tool: string; data: { handle: string }[] }[] };
    expect(body.fallback).toBe(true);
    expect(body.answer).toMatch(/@madina \(3 дн\. назад\)/);
    expect(body.answer).toMatch(/Зарина/);
    expect(body.sources[0].tool).toBe("notOpened");
    expect(body.sources[0].data.map((r) => r.handle)).toEqual(["@madina", "Зарина"]);
  });

  it("черновик draftReply — текст и адресат в draft, ничего не создаётся в ленте", async () => {
    db.model("contact").findMany.mockResolvedValue([{ id: "c1", username: "madina", name: "Мадина", igUserId: "111", paid: true, offlineSignup: null }]);
    db.model("purchase").findFirst.mockResolvedValue({ courseId: "course-1", courseRef: { title: "21 рецепт" } });
    generateWithFallback.mockResolvedValueOnce(call("draftReply", { studentQuery: "Мадина", topic: "сливки" })).mockResolvedValueOnce(say("Черновик готов — скопируйте и отправьте сами."));
    const out = await ask({ question: "напиши Мадине ответ про сливки" });
    expect(out.body).toMatchObject({ draft: { text: "Сливки 33% — как в рецепте.", forContactId: "c1" } });
    expect(db.model("courseChatMessage").create).not.toHaveBeenCalled();
  });

  it("20 вопросов в час — 21-й получает 429", async () => {
    generateWithFallback.mockResolvedValue(say("ок"));
    for (let i = 0; i < 20; i++) expect((await ask({ question: "привет как дела" })).status).toBe(200);
    expect((await ask({ question: "привет как дела" })).status).toBe(429);
  });

  it("POST без вопроса — 400", async () => {
    const res = await fetch(`${base}/admin/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "" }) });
    expect(res.status).toBe(400);
  });
});
