import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { waitingRouter, waitingName, replyUrlOf, type WaitingClient } from "../../src/waiting.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(waitingRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const NOW = new Date("2026-11-08T10:00:00Z").getTime();
const msg = (direction: "IN" | "OUT", minutesAgo: number, text: string | null = "Здравствуйте") => ({
  direction,
  text,
  createdAt: new Date(NOW - minutesAgo * 60_000),
});

describe("GET /admin/v1/waiting", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    restorePrisma();
  });

  it("берёт только тех, чьё последнее сообщение входящее; кто ждёт дольше — первым", async () => {
    db.model("contact").findMany.mockResolvedValue([
      {
        id: "a",
        channel: "INSTAGRAM",
        igUserId: "1",
        username: "madina",
        name: null,
        messages: [msg("IN", 5, "Позовите Ширин")],
      },
      { id: "b", channel: "INSTAGRAM", igUserId: "2", username: "zarina", name: null, messages: [msg("OUT", 5)] },
      {
        id: "c",
        channel: "WHATSAPP",
        igUserId: "wa:+992 900 11 22 33",
        username: null,
        name: "Нигина",
        messages: [msg("IN", 90, null)],
      },
      { id: "d", channel: "WEB", igUserId: "v1", username: null, name: null, messages: [msg("IN", 60 * 24 * 9)] },
      { id: "e", channel: "WEB", igUserId: "v2", username: null, name: null, messages: [] },
    ]);
    const res = await fetch(`${base}/admin/v1/waiting`);
    const body = (await res.json()) as { count: number; clients: WaitingClient[] };
    expect(body.count).toBe(2);
    expect(body.clients.map((c) => c.contactId)).toEqual(["c", "a"]);
    expect(body.clients[0]).toMatchObject({
      name: "Нигина",
      channelLabel: "WhatsApp",
      replyUrl: "https://wa.me/992900112233",
      lastText: "Прислал(а) фото или файл",
    });
    expect(body.clients[1]).toMatchObject({
      name: "@madina",
      replyUrl: "https://www.instagram.com/madina/",
      lastText: "Позовите Ширин",
    });
  });

  it("не просит личных, заблокированных и сохранённых контактов", async () => {
    db.model("contact").findMany.mockResolvedValue([]);
    await fetch(`${base}/admin/v1/waiting`);
    const where = (db.model("contact").findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ personal: false, spamBlockedAt: null, whatsappSavedContact: false });
  });

  it("имя и ссылка без выдумок", () => {
    expect(waitingName({ channel: "WEB", igUserId: "x", username: null, name: null })).toBe("Клиент без имени");
    expect(replyUrlOf({ channel: "WEB", igUserId: "x", username: null, name: null })).toBeNull();
    expect(replyUrlOf({ channel: "WHATSAPP", igUserId: "wa:12", username: null, name: null })).toBeNull();
  });
});
