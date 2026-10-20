import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/health.js", () => ({
  healthReport: vi.fn(async () => ({ ok: true, db: true, diskFreePct: 42, secondsSinceWorkerTick: 3, problems: [] })),
  markWorkerTick: vi.fn(),
}));
vi.mock("../../src/storage/s3.js", () => ({ storageConfig: vi.fn(async () => ({ bucket: "b" })) }));

import { todayRouter, resetTodayCache, guessCourse, type TodayResponse } from "../../src/today.js";
import { DEFAULT_PRICES } from "../../src/prices.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(todayRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const contact = { id: "c1", username: "madina", igUserId: "ig-1", channel: "INSTAGRAM" };
const DAY = 86_400_000;

function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { key: where.key, value: values[where.key] } : null;
}

describe("GET /admin/today", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetTodayCache();
    vi.useFakeTimers();
    // 10:00 по Душанбе (UTC+5) — обычное «утро Ширин».
    vi.setSystemTime(new Date("2026-09-05T05:00:00Z"));
    db.model("setting").findUnique.mockImplementation(
      settings({ aiEnabled: "true", igToken: "tok", "aiBudget:global:2026-09-05": JSON.stringify({ calls: 850 }) })
    );
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("receiptCheck").findMany.mockResolvedValue([]);
    db.model("courseChatMessage").findMany.mockResolvedValue([]);
    db.model("courseChatMessage").count.mockResolvedValue(0);
    db.model("contact").findMany.mockResolvedValue([]);
    db.model("contact").count.mockResolvedValue(0);
    db.model("lesson").findMany.mockResolvedValue([]);
    db.model("lesson").count.mockResolvedValue(0);
    db.model("certificate").findMany.mockResolvedValue([]);
    db.model("progress").findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    restorePrisma();
  });

  async function today(query = ""): Promise<TodayResponse> {
    const res = await fetch(`${base}/admin/today${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TodayResponse;
  }

  it("форма ответа: утренние числа, 14 дней спарклайна, очередь, новости, статус", async () => {
    const now = Date.now();
    db.model("purchase").findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: { amount?: boolean; firstOpenedAt?: boolean } };
      if (a.select?.firstOpenedAt) return [];
      return [
        { amount: 70, createdAt: new Date(now - 1 * DAY) }, // вчера
        { amount: 50, createdAt: new Date(now - 1 * DAY - 3600_000) }, // вчера
        { amount: 100, createdAt: new Date(now - 2 * DAY) }, // позавчера
        { amount: 70, createdAt: new Date(now - 10 * DAY) }, // прошлая неделя
      ];
    });
    db.model("receiptCheck").findMany.mockResolvedValue([
      { id: "r1", contact, imageUrl: "/media/r.jpg", amount: 70, reason: "похож", confidence: 61, createdAt: new Date(now - 3600_000) },
    ]);
    db.model("courseChatMessage").findMany.mockResolvedValue([
      { id: "q1", text: "Можно молоко?", createdAt: new Date(now - 7200_000), lesson: { title: "Урок 3" }, purchase: { contact } },
    ]);
    db.model("courseChatMessage").count.mockResolvedValue(1);
    db.model("contact").findMany.mockResolvedValue([{ ...contact, paidAt: new Date(now - 3 * DAY) }]);
    db.model("lesson").findMany.mockResolvedValue([{ id: "l7", title: "Урок 7" }]);
    db.model("lesson").count.mockResolvedValue(3);
    db.model("certificate").findMany.mockResolvedValue([
      { contactId: "c1", contact, course: { title: "21 рецепт" }, issuedAt: new Date(now - DAY) },
    ]);

    const body = await today();

    expect(body.money).toMatchObject({ yesterday: 120, dayBefore: 100, salesYesterday: 2, week: 220, prevWeek: 70 });
    expect(body.pendingReceipts).toBe(1);
    expect(body.unansweredQuestions).toBe(1);
    expect(body.sparkline).toHaveLength(14);
    expect(body.sparkline.at(-2)).toMatchObject({ day: "2026-09-04", money: 120, sales: 2 });

    expect(body.queue.map((q) => q.kind)).toEqual(["receipt", "question", "notOpened", "transcodeFailed", "recipesToReview", "gemini"]);
    expect(body.queue.find((q) => q.kind === "recipesToReview")).toMatchObject({ count: 3 });
    const receipt = body.queue[0];
    expect(receipt).toMatchObject({
      kind: "receipt",
      id: "r1",
      amount: 70,
      courseGuess: "21 рецепт",
      who: { handle: "@madina", instagramUrl: "https://www.instagram.com/madina/" },
    });
    expect(body.queue[1]).toMatchObject({ kind: "question", id: "q1", lesson: "Урок 3", text: "Можно молоко?" });
    expect(body.queue[2]).toMatchObject({ kind: "notOpened", daysAgo: 3 });
    expect(body.queue[5]).toMatchObject({ kind: "gemini", calls: 850, limit: 1000, percent: 85 });

    expect(body.goodNews[0]).toMatchObject({ kind: "certificate", course: "21 рецепт", who: { handle: "@madina" } });
    expect(body.goodNews[0].reviewText).toContain("отзыв");

    expect(body.system).toEqual({
      bot: true,
      instagram: true,
      storage: true,
      diskFreePct: 42,
      gemini: { calls: 850, limit: 1000 },
      problems: [],
    });
  });

  it("Gemini ниже 80% — карточки в очереди нет; кэш 30 с, ?fresh=1 обходит его", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ "aiBudget:global:2026-09-05": JSON.stringify({ calls: 10 }) }));
    const first = await today();
    expect(first.queue.some((q) => q.kind === "gemini")).toBe(false);
    expect(first.system.bot).toBe(false);

    db.model("receiptCheck").findMany.mockResolvedValue([
      { id: "r2", contact, imageUrl: null, amount: null, reason: "", confidence: 0, createdAt: new Date() },
    ]);
    expect((await today()).pendingReceipts).toBe(0); // из кэша
    expect((await today("?fresh=1")).pendingReceipts).toBe(1);
    vi.advanceTimersByTime(31_000);
    db.model("receiptCheck").findMany.mockResolvedValue([]);
    expect((await today()).pendingReceipts).toBe(0); // кэш протух
  });

  it("хорошие новости «прошла курс»: все READY-уроки закрыты за неделю, с сертификатом — не дублируется", async () => {
    const now = Date.now();
    const zarina = { id: "c2", username: "zarina", igUserId: "ig-2", channel: "WEB" };
    db.model("progress").findMany
      // свежие завершения → две покупки-кандидата
      .mockResolvedValueOnce([
        { purchaseId: "p1", purchase: { contactId: "c1", courseId: "k", courseRef: { title: "21 рецепт" } } },
        { purchaseId: "p2", purchase: { contactId: "c2", courseId: "k", courseRef: { title: "21 рецепт" } } },
      ])
      // все завершённые уроки этих покупок
      .mockResolvedValueOnce([
        { purchaseId: "p1", lessonId: "l1", completedAt: new Date(now - 2 * DAY) },
        { purchaseId: "p2", lessonId: "l1", completedAt: new Date(now - 3 * DAY) },
        { purchaseId: "p2", lessonId: "l2", completedAt: new Date(now - DAY) },
      ]);
    db.model("lesson").findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { status?: string } };
      return a.where?.status === "READY" ? [{ id: "l1", module: { courseId: "k" } }, { id: "l2", module: { courseId: "k" } }] : [];
    });
    db.model("certificate").findMany.mockResolvedValue([
      { contactId: "c1", contact, course: { title: "21 рецепт" }, issuedAt: new Date(now - DAY) },
    ]);
    db.model("contact").findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { id?: { in?: string[] } } };
      return a.where?.id?.in ? [zarina] : [];
    });

    const body = await today("?fresh=1");
    const finished = body.goodNews.filter((n) => n.kind === "finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      who: { handle: "@zarina", instagramUrl: null, channel: "WEB" },
      course: "21 рецепт",
      at: new Date(now - DAY).toISOString(),
    });
    expect(finished[0].reviewText).toContain("21 рецепт");
    // @madina с сертификатом — только карточка «сертификат», без второй «прошла курс».
    expect(body.goodNews.filter((n) => n.who.handle === "@madina").map((n) => n.kind)).toEqual(["certificate"]);
  });

  it("guessCourse: те же допуски, что у allocate()", () => {
    expect(guessCourse(48, DEFAULT_PRICES)).toBe("Арт-десерты");
    expect(guessCourse(70, DEFAULT_PRICES)).toBe("21 рецепт");
    expect(guessCourse(100, DEFAULT_PRICES)).toBe("оба курса");
    expect(guessCourse(120, DEFAULT_PRICES)).toBe("оба курса");
    expect(guessCourse(20, DEFAULT_PRICES)).toBeNull();
    expect(guessCourse(null, DEFAULT_PRICES)).toBeNull();
  });
});
