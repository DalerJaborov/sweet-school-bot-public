import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Сквозные проверки раздела «Ссылки» с соседними модулями:
 *  • кука ssb_src доходит до контакта чата на сайте и до заявки на бесплатный урок;
 *  • «Отобрать доступ» гасит ручные ссылки ученицы и не молчит, если не вышло.
 */

vi.mock("../../src/ai.js", () => ({
  aiReply: vi.fn(async () => undefined),
  rescueImage: vi.fn(),
  rescueIncomingImages: vi.fn(),
  aiReplyToComment: vi.fn(),
  grantCourses: vi.fn(),
  handleReceiptVerdict: vi.fn(),
}));
vi.mock("../../src/systemAlerts.js", () => ({ notifyOwnerDirect: vi.fn(async () => undefined) }));

import { siteRouter, resetSiteRateLimits } from "../../src/site/router.js";
import { freeLessonRouter } from "../../src/site/freeLesson.js";
import { revokeAccess } from "../../src/groupAccess.js";

let server: Server;
let base = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(siteRouter);
  app.use(freeLessonRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let db: PrismaMock;
let settings: Record<string, string>;
beforeEach(() => {
  resetSiteRateLimits();
  db = mockPrisma();
  settings = {};
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] != null ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("siteLink").findUnique.mockImplementation(async ({ where }: { where: { code: string } }) =>
    where.code === "abc234" ? { id: "link-1" } : null,
  );
});
afterEach(restorePrisma);

const post = (path: string, body: unknown, cookie: string) =>
  realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-forwarded-for": "10.3.3.3" },
    body: JSON.stringify(body),
  });

describe("кука рекламной ссылки → заявка", () => {
  it("чат на сайте: контакт посетителя помечается ссылкой", async () => {
    db.model("contact").upsert.mockResolvedValue(fakeContact({ id: "web-1", channel: "WEB", siteLinkId: null }));
    const res = await post("/api/site/chat/start", {}, "ssb_src=abc234");
    expect(res.status).toBe(200);
    expect(db.model("contact").updateMany).toHaveBeenCalledWith({
      where: { id: "web-1", siteLinkId: null },
      data: { siteLinkId: "link-1" },
    });
  });

  it("заявка на бесплатный урок хранит ссылку", async () => {
    settings = { freeLessonEnabled: "true", freeLessonId: "lesson-1" };
    db.model("lesson").findFirst.mockResolvedValue({ id: "lesson-1" });
    db.model("freeLessonLead").create.mockResolvedValue({ id: "lead-1" });
    const res = await post(
      "/api/v1/free-lesson/signup",
      { name: "Мадина", phone: "+992 900 000 001", lang: "tg" },
      "ssb_src=abc234",
    );
    expect(res.status).toBe(200);
    const data = (db.model("freeLessonLead").create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.siteLinkId).toBe("link-1");
  });

  it("без куки поле не пишется, контакт не трогаем", async () => {
    db.model("contact").upsert.mockResolvedValue(fakeContact({ id: "web-2", channel: "WEB", siteLinkId: null }));
    await post("/api/site/chat/start", {}, "a=b");
    expect(db.model("siteLink").findUnique).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
});

describe("«Отобрать доступ» и ручные ссылки из «Ссылок»", () => {
  let revokeAnswer: { ok: boolean; description?: string };
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    revokeAnswer = { ok: true };
    settings = { telegramBotToken: "1:abc", telegramChatId50: "-1001" };
    db.model("contact").findUnique.mockResolvedValue(
      fakeContact({ id: "c-1", inviteLink: null, telegramUserId: null }),
    );
    db.model("telegramInvite").findMany.mockResolvedValue([{ id: "inv-1" }]);
    db.model("telegramInvite").findUnique.mockResolvedValue({
      id: "inv-1",
      groupKey: "COURSE50",
      chatId: "-1001",
      inviteLink: "https://t.me/+Manual",
      revokedAt: null,
    });
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("receiptCheck").findMany.mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const method = String(input).split("/").pop() ?? "";
      calls.push(method);
      return new Response(
        JSON.stringify(method === "revokeChatInviteLink" ? revokeAnswer : { ok: true, result: { message_id: 1 } }),
      );
    });
  });

  it("ручная ссылка ученицы гасится", async () => {
    const result = await revokeAccess("c-1");
    expect(result.ok).toBe(true);
    expect(calls).toContain("revokeChatInviteLink");
    expect(db.model("telegramInvite").updateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result.warning).toBeUndefined();
  });

  it("не вышло отозвать — не молчит, а просит отозвать вручную", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    revokeAnswer = { ok: false, description: "Bad Request: CHAT_ADMIN_REQUIRED" };
    const result = await revokeAccess("c-1");
    expect(result.warning).toContain("не отозвана");
    expect(result.details).toContain("«Ссылки»");
    expect(db.model("telegramInvite").updateMany).not.toHaveBeenCalled();
  });
});
