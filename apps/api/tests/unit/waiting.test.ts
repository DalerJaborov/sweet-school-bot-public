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
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000);

type Msg = {
  contactId: string;
  direction: "IN" | "OUT";
  byHuman?: boolean;
  payload?: string | null;
  text?: string | null;
  createdAt: Date;
};
type Contact = {
  id: string;
  channel: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  humanSilencedUntil?: Date | null;
  humanTakenOverAt?: Date | null;
};

/** Мини-база: честно применяет фильтры сообщений, которые waiting.ts просит у Prisma. */
function fakeDb(
  db: PrismaMock,
  contacts: Contact[],
  messages: Msg[],
  settings: Record<string, string> = { aiEnabled: "true" },
) {
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] != null ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("contact").findMany.mockImplementation(async (args: unknown) => {
    const a = args as { select: { messages: { where: { direction: string; payload: null } } } };
    const w = a.select.messages.where;
    return contacts.map((c) => ({
      humanSilencedUntil: null,
      humanTakenOverAt: null,
      ...c,
      messages: messages
        .filter((m) => m.contactId === c.id && m.direction === w.direction && (m.payload ?? null) === w.payload)
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
        .slice(0, 1),
    }));
  });
  db.model("message").findMany.mockImplementation(async (args: unknown) => {
    const a = args as { where: { contactId: { in: string[] }; direction: string; byHuman: boolean } };
    return messages
      .filter(
        (m) =>
          a.where.contactId.in.includes(m.contactId) &&
          m.direction === a.where.direction &&
          Boolean(m.byHuman) === a.where.byHuman,
      )
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  });
}

async function waiting() {
  const res = await fetch(`${base}/admin/v1/waiting`);
  return (await res.json()) as { count: number; aiOff: boolean; clients: WaitingClient[] };
}

const insta = (id: string, username: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  channel: "INSTAGRAM",
  igUserId: id,
  username,
  name: null,
  ...extra,
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

  it("цепочка «просьба позвать человека → ответ бота „зову Ширин“»: клиент остаётся в списке", async () => {
    fakeDb(
      db,
      [insta("a", "madina", { humanSilencedUntil: new Date(NOW + 55 * 60_000) })],
      [
        { contactId: "a", direction: "IN", text: "Позовите Ширин", createdAt: at(5) },
        { contactId: "a", direction: "OUT", byHuman: false, text: "Сейчас позову Ширин", createdAt: at(5) },
      ],
    );
    const body = await waiting();
    expect(body.clients.map((c) => c.contactId)).toEqual(["a"]);
    expect(body.clients[0]).toMatchObject({
      name: "@madina",
      lastText: "Позовите Ширин",
      replyUrl: "https://ig.me/m/madina",
    });
  });

  it("ответила живая Ширин — клиент уходит из списка; написал снова — возвращается", async () => {
    const c = insta("a", "madina", { humanTakenOverAt: at(60) });
    fakeDb(
      db,
      [c],
      [
        { contactId: "a", direction: "IN", text: "Вопрос", createdAt: at(30) },
        { contactId: "a", direction: "OUT", byHuman: true, text: "Ответ", createdAt: at(20) },
      ],
    );
    expect((await waiting()).count).toBe(0);
    fakeDb(
      db,
      [c],
      [
        { contactId: "a", direction: "IN", text: "Вопрос", createdAt: at(30) },
        { contactId: "a", direction: "OUT", byHuman: true, text: "Ответ", createdAt: at(20) },
        { contactId: "a", direction: "IN", text: "А ещё?", createdAt: at(2) },
      ],
    );
    expect((await waiting()).clients[0].lastText).toBe("А ещё?");
  });

  it("обычный разговор с ботом сюда не попадает", async () => {
    fakeDb(
      db,
      [insta("a", "zarina", { humanSilencedUntil: at(600) })],
      [{ contactId: "a", direction: "IN", text: "Цена?", createdAt: at(300) }],
    );
    // тишина закончилась до сообщения клиента → бот ответит сам
    expect((await waiting()).count).toBe(0);
  });

  it("нажатия кнопок воронки — не вопрос человеку", async () => {
    fakeDb(
      db,
      [insta("a", "zarina", { humanTakenOverAt: at(900) })],
      [{ contactId: "a", direction: "IN", text: "Да", payload: "btn:yes", createdAt: at(5) }],
    );
    expect((await waiting()).count).toBe(0);
  });

  it("помощник выключен (aiEnabled не true) — ждут все, кто написал; карточка говорит об этом", async () => {
    fakeDb(
      db,
      [insta("a", "madina"), { id: "b", channel: "WEB", igUserId: "v", username: null, name: null }],
      [
        { contactId: "a", direction: "IN", text: "Здравствуйте", createdAt: at(50) },
        { contactId: "b", direction: "IN", text: null, createdAt: at(10) },
      ],
      { aiEnabled: "false" },
    );
    const body = await waiting();
    expect(body.aiOff).toBe(true);
    expect(body.clients.map((c) => c.contactId)).toEqual(["a", "b"]);
    expect(body.clients[1]).toMatchObject({
      name: "Клиент без имени",
      replyUrl: null,
      lastText: "Прислал(а) фото или файл",
    });
    // и условие по тишине в запросе не требуется
    const where = (db.model("contact").findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toBeUndefined();
  });

  it("запрос: только свежие входящие, без личных/спама, с сортировкой и пределом", async () => {
    fakeDb(db, [], []);
    await waiting();
    const q = db.model("contact").findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(q.where).toMatchObject({ personal: false, spamBlockedAt: null, whatsappSavedContact: false });
    expect(q.where.messages).toMatchObject({ some: { direction: "IN", payload: null } });
    expect(q.orderBy).toEqual({ updatedAt: "desc" });
    expect(q.take).toBeGreaterThan(0);
  });

  it("кто ждёт дольше — первым; старше недели не берём", async () => {
    fakeDb(
      db,
      [
        insta("a", "a1", { humanTakenOverAt: at(5000) }),
        insta("b", "b1", { humanTakenOverAt: at(5000) }),
        insta("c", "c1", { humanTakenOverAt: at(99999) }),
      ],
      [
        { contactId: "a", direction: "IN", text: "новее", createdAt: at(5) },
        { contactId: "b", direction: "IN", text: "старее", createdAt: at(90) },
        { contactId: "c", direction: "IN", text: "давно", createdAt: at(60 * 24 * 9) },
      ],
    );
    expect((await waiting()).clients.map((c) => c.contactId)).toEqual(["b", "a"]);
  });

  it("имя и ссылка без выдумок; WhatsApp без ссылки", () => {
    expect(waitingName({ channel: "WEB", igUserId: "x", username: null, name: null })).toBe("Клиент без имени");
    expect(replyUrlOf({ channel: "WEB", igUserId: "x", username: null, name: null })).toBeNull();
    expect(replyUrlOf({ channel: "WHATSAPP", igUserId: "wa:99290011223", username: null, name: "Нигина" })).toBeNull();
    expect(replyUrlOf({ channel: "INSTAGRAM", igUserId: "1", username: null, name: null })).toBeNull();
  });
});
