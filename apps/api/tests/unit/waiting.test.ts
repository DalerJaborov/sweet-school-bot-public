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

type Contact = { id: string; channel: string; igUserId: string; username: string | null; name: string | null; humanRequestedAt?: Date | null };
type Human = { contactId: string; createdAt: Date };
type Pending = { contactId: string; text: string; createdAt: Date; attempts?: number };
type Inbox = { contactId: string; chatId?: string; kind?: string; text?: string; media?: boolean; attentionReason?: string | null; createdAt: Date };

function fake(db: PrismaMock, o: { contacts: Contact[]; human?: Human[]; pending?: Pending[]; inbox?: Inbox[] }) {
  db.model("contact").findMany.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { humanRequestedAt?: unknown; id?: { in: string[] } } }).where;
    if (where.humanRequestedAt) return o.contacts.filter((c) => c.humanRequestedAt);
    return o.contacts.filter((c) => where.id!.in.includes(c.id));
  });
  db.model("message").findMany.mockResolvedValue(o.human ?? []);
  db.model("pendingAiReply").findMany.mockResolvedValue((o.pending ?? []).filter((p) => (p.attempts ?? 2) >= 2));
  db.model("whatsAppInbox").findMany.mockResolvedValue(
    (o.inbox ?? []).map((i) => ({
      contactId: i.contactId,
      chatId: i.chatId ?? "992900112233@c.us",
      kind: i.kind ?? "message",
      status: "attention",
      attentionReason: i.attentionReason ?? "generation",
      createdAt: i.createdAt,
      payload: JSON.stringify(i.media ? { media: { mimeType: "image/jpeg" } } : { text: i.text ?? "" }),
    }))
  );
}

async function waiting() {
  const res = await fetch(`${base}/admin/v1/waiting`);
  return (await res.json()) as { count: number; clients: WaitingClient[] };
}
const insta = (id: string, username: string, extra: Partial<Contact> = {}): Contact => ({ id, channel: "INSTAGRAM", igUserId: id, username, name: null, ...extra });

describe("GET /admin/v1/waiting — только то, что бот передал человеку", () => {
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

  it("просьба позвать Ширин: имя, канал, причина простыми словами; текста переписки в ответе нет", async () => {
    fake(db, { contacts: [insta("a", "madina", { humanRequestedAt: at(5) })] });
    const body = await waiting();
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]).toMatchObject({ name: "@madina", channelLabel: "Instagram", reason: "Просит позвать Ширин", replyUrl: "https://ig.me/m/madina" });
    expect(JSON.stringify(body)).not.toContain("lastText");
  });

  it("обычное последнее входящее («Рахмат», «Хоб майла») никогда не попадает — нет метки передачи", async () => {
    fake(db, { contacts: [insta("a", "zarina")] }); // humanRequestedAt нет
    expect((await waiting()).count).toBe(0);
    // и запрос не смотрит на переписку и на aiEnabled вовсе
    expect(db.model("setting").findUnique).not.toHaveBeenCalled();
  });

  it("после ответа живой Ширин просьба считается закрытой; позже новая — возвращается", async () => {
    fake(db, { contacts: [insta("a", "madina", { humanRequestedAt: at(60) })], human: [{ contactId: "a", createdAt: at(30) }] });
    expect((await waiting()).count).toBe(0);
    fake(db, { contacts: [insta("a", "madina", { humanRequestedAt: at(5) })], human: [{ contactId: "a", createdAt: at(30) }] });
    expect((await waiting()).count).toBe(1);
  });

  it("бот не смог ответить: завис в очереди повторов — показываем, пустяк — нет", async () => {
    fake(db, {
      contacts: [insta("a", "madina"), insta("b", "zarina")],
      pending: [
        { contactId: "a", text: "Сколько стоит курс?", createdAt: at(40) },
        { contactId: "b", text: "Рахмат", createdAt: at(30) },
      ],
    });
    const body = await waiting();
    expect(body.clients.map((c) => [c.contactId, c.reason])).toEqual([["a", "Помощник не смог ответить"]]);
  });

  it("WhatsApp «нужен ответ»: фото без текста — показываем, «Рахмат» и реакция — нет", async () => {
    fake(db, {
      contacts: [
        { id: "w1", channel: "WHATSAPP", igUserId: "wa:1", username: null, name: "Нигина" },
        { id: "w2", channel: "WHATSAPP", igUserId: "wa:2", username: null, name: "Дилафруз" },
        { id: "w3", channel: "WHATSAPP", igUserId: "wa:3", username: null, name: "Малика" },
        { id: "w4", channel: "WHATSAPP", igUserId: "wa:4", username: null, name: "Зарина" },
      ],
      inbox: [
        { contactId: "w1", media: true, attentionReason: "media_unavailable", createdAt: at(20) },
        { contactId: "w2", text: "Рахмат 🙏", createdAt: at(15) },
        { contactId: "w3", kind: "reaction", createdAt: at(10) },
        { contactId: "w4", text: "Не получается оплатить", createdAt: at(5) },
      ],
    });
    const body = await waiting();
    expect(body.clients.map((c) => c.contactId)).toEqual(["w1", "w4"]);
    expect(body.clients[0].reason).toContain("файл");
    expect(body.clients[0].replyUrl).toBeNull(); // wa.me не ставим
  });

  it("у одного клиента несколько причин — одна карточка, «просит позвать» важнее", async () => {
    fake(db, {
      contacts: [insta("a", "madina", { humanRequestedAt: at(5) })],
      pending: [{ contactId: "a", text: "Помогите с оплатой", createdAt: at(50) }],
    });
    const body = await waiting();
    expect(body.count).toBe(1);
    expect(body.clients[0].reason).toBe("Просит позвать Ширин");
  });

  it("личных и заблокированных за спам не просим у базы", async () => {
    fake(db, { contacts: [] });
    await waiting();
    const q = db.model("contact").findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(q.where).toMatchObject({ personal: false, spamBlockedAt: null, whatsappSavedContact: false });
  });

  it("имя и ссылка без выдумок; WhatsApp без ссылки", () => {
    expect(waitingName({ channel: "WEB", igUserId: "x", username: null, name: null })).toBe("Клиент без имени");
    expect(replyUrlOf({ channel: "WEB", igUserId: "x", username: null, name: null })).toBeNull();
    expect(replyUrlOf({ channel: "WHATSAPP", igUserId: "wa:99290011223", username: null, name: "Нигина" })).toBeNull();
    expect(replyUrlOf({ channel: "INSTAGRAM", igUserId: "1", username: null, name: null })).toBeNull();
  });
});
