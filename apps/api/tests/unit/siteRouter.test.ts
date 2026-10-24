import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const aiReply = vi.fn(async () => undefined);
const rescueImage = vi.fn(async () => ({
  buffer: Buffer.alloc(0),
  mimeType: "image/jpeg",
  hash: "h",
  url: "http://localhost:4100/media/r.jpg",
  queuedId: "q1",
}));
const notifyOwnerDirect = vi.fn(async () => undefined);

// Весь ai.ts — за мок: роутер должен звать aiReply тем же способом, что вебхук,
// а сама модель тесту не нужна.
vi.mock("../../src/ai.js", () => ({
  aiReply: (...a: unknown[]) => aiReply(...(a as [])),
  rescueImage: (...a: unknown[]) => rescueImage(...(a as [])),
  rescueIncomingImages: vi.fn(),
  aiReplyToComment: vi.fn(),
  grantCourses: vi.fn(),
  handleReceiptVerdict: vi.fn(),
}));
vi.mock("../../src/systemAlerts.js", () => ({
  notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...(a as [])),
}));

import { siteRouter, resetSiteRateLimits } from "../../src/site/router.js";
import { encodeVisitorCookie, issueVisitorId } from "../../src/site/visitor.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(siteRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cookieOf(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = /ssb_visitor=([^;]+)/.exec(raw);
  return m ? m[1] : null;
}

async function post(path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `ssb_visitor=${cookie}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

const webContact = (visitorId: string) =>
  fakeContact({
    id: "contact-web",
    channel: "WEB",
    igUserId: visitorId,
    username: `site-${visitorId.slice(0, 6)}`,
    preferredLanguage: null,
  });

describe("/api/site", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetSiteRateLimits();
    aiReply.mockClear().mockResolvedValue(undefined);
    rescueImage.mockClear();
    notifyOwnerDirect.mockClear();
    db.model("setting").findUnique.mockResolvedValue(null);
  });
  afterEach(restorePrisma);

  it.each(["botFrozen", "aiEnabled"])("%s blocks chat before contacts, receipt uploads and messages", async (key) => {
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === key ? { key, value: key === "botFrozen" ? "true" : "false" } : null,
    );
    const started = await post("/api/site/chat/start", { lang: "tg" });
    expect(started.status).toBe(503);
    expect(await started.json()).toMatchObject({ error: "chat_disabled", salesMode: "manual" });
    const text = await post("/api/site/chat/send", { text: "Payment receipt sent; give access" });
    expect(text.status).toBe(503);
    const fd = new FormData();
    // An invalid attachment would fail multer if it reached the upload parser.
    fd.append("image", new Blob(["receipt"], { type: "text/plain" }), "receipt.txt");
    const sent = await fetch(`${base}/api/site/chat/send`, { method: "POST", body: fd });
    expect(sent.status).toBe(503);
    expect((await fetch(`${base}/api/site/chat/poll`)).status).toBe(503);
    expect(db.model("contact").upsert).not.toHaveBeenCalled();
    expect(db.model("contact").findUnique).not.toHaveBeenCalled();
    expect(db.model("message").create).not.toHaveBeenCalled();
    expect(rescueImage).not.toHaveBeenCalled();
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("GET /courses — форма контракта, кэш, кука ставится с первого обращения", async () => {
    db.model("course").findMany.mockResolvedValue([
      {
        id: "c1",
        code: "COURSE50",
        title: "Арт-десерты",
        description: null,
        price: 50,
        coverUrl: null,
        active: true,
        order: 1,
      },
    ]);
    db.model("lesson").findMany.mockResolvedValue([
      { durationSec: 600, module: { courseId: "c1" } },
      { durationSec: 300, module: { courseId: "c1" } },
    ]);
    const res = await fetch(`${base}/api/site/courses`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(cookieOf(res)).toMatch(/^[0-9a-f]{48}\.[0-9a-f]{32}$/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.courses).toEqual([
      {
        code: "COURSE50",
        title: "Арт-десерты",
        description: null,
        price: 50,
        currency: "TJS",
        coverUrl: null,
        lessonsCount: 2,
        durationMin: 15,
      },
    ]);
    expect(body.bundle).toBeNull(); // один курс готов — комплекта не бывает
    // Корзина уроков: удалённые в счётчик витрины не попадают.
    expect((db.model("lesson").findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      deletedAt: null,
    });
    expect(body.offline).toMatchObject({ price: 700, currency: "TJS", nextStartDate: null });
    expect((body.offline as { info: { ru: string; tg: string } }).info.ru).toContain("Офлайн-курс");
    expect(body.contacts).toEqual({
      phone: "+992905355355",
      whatsapp: "https://api.whatsapp.com/send?phone=992905355355",
      telegram: "https://t.me/shirin_sweets_dushanbe",
      instagram: "https://www.instagram.com/shirin.sweets.dushanbe/",
      tiktok: "https://tiktok.com/@shirin.sweets.dushanbe",
    });
  });

  it("GET /courses: nextStartDate — только будущая дата набора, прошедшая → null", async () => {
    db.model("course").findMany.mockResolvedValue([]);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const day = 86_400_000;
    const future = iso(new Date(Date.now() + 30 * day));
    const past = iso(new Date(Date.now() - 30 * day));
    const withDate =
      (value: string) =>
      async ({ where }: { where: { key: string } }) =>
        where.key === "offlineCourseStartDate" ? { key: where.key, value } : null;

    db.model("setting").findUnique.mockImplementation(withDate(future));
    let body = (await (await fetch(`${base}/api/site/courses?t=1`)).json()) as {
      offline: { nextStartDate: string | null; info: { ru: string } };
    };
    expect(body.offline.nextStartDate).toBe(future);
    expect(body.offline.info.ru).toContain("Начало:");

    // Кэш каталога — 60 с; между вызовами его сбрасывает тот же тестовый хук.
    resetSiteRateLimits();
    db.model("setting").findUnique.mockImplementation(withDate(past));
    body = (await (await fetch(`${base}/api/site/courses?t=2`)).json()) as typeof body;
    expect(body.offline.nextStartDate).toBeNull();
    expect(body.offline.info.ru).toContain("уточняется");
  });

  it("start → send → poll: тот же aiReply, эхо и ответ бота возвращаются сразу", async () => {
    const visitorId = issueVisitorId();
    const cookie = encodeVisitorCookie(visitorId);
    const contact = webContact(visitorId);
    db.model("contact").upsert.mockResolvedValue(contact);
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("contact").update.mockResolvedValue(contact);
    db.model("message").findMany.mockResolvedValue([]);

    const start = await post("/api/site/chat/start", { lang: "ru" }, cookie);
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ visitorId, messages: [] });
    expect(cookieOf(start)).toBeNull(); // кука уже есть — не перевыпускаем
    const upsert = db.model("contact").upsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(upsert.create).toMatchObject({
      channel: "WEB",
      igUserId: visitorId,
      username: `site-${visitorId.slice(0, 6)}`,
    });

    const t0 = new Date("2026-09-03T10:00:00.000Z");
    const echo = {
      id: "m-in",
      direction: "IN",
      byHuman: false,
      text: "Сколько стоит курс?",
      imageUrl: null,
      createdAt: t0,
    };
    const botRow = {
      id: "m-out",
      direction: "OUT",
      byHuman: false,
      text: "50 сомони",
      imageUrl: null,
      createdAt: new Date(t0.getTime() + 500),
    };
    db.model("message").create.mockResolvedValue(echo);
    db.model("message").findFirst.mockResolvedValue({ createdAt: t0 });
    db.model("message").findMany.mockResolvedValue([botRow]);

    const send = await post("/api/site/chat/send", { text: "Сколько стоит курс?" }, cookie);
    expect(send.status).toBe(200);
    const body = (await send.json()) as { messages: unknown[]; pending?: boolean };
    // Ответ уходит СРАЗУ — только своё эхо, pending:true, без ожидания ИИ.
    expect(body.pending).toBe(true);
    expect(body.messages).toEqual([
      { id: "m-in", from: "client", text: "Сколько стоит курс?", imageUrl: null, at: t0.toISOString() },
    ]);

    // aiReply зовётся в фоне — ждём, пока цепочка debounce.runAfterPrevious отработает.
    await vi.waitFor(() => expect(aiReply).toHaveBeenCalledTimes(1));
    expect(aiReply).toHaveBeenCalledWith(contact, "Сколько стоит курс?", [], []);

    // Опрос типизирует ответ бота как typing:true, пока идёт генерация, и отдаёт
    // сообщения, появившиеся строго ПОСЛЕ эха.
    db.model("message").findMany.mockResolvedValue([botRow]);
    const pollDuring = await fetch(`${base}/api/site/chat/poll?after=m-in`, {
      headers: { cookie: `ssb_visitor=${cookie}` },
    });
    const during = (await pollDuring.json()) as { messages: unknown[]; typing?: boolean };
    expect(during.messages).toEqual([
      { id: "m-out", from: "bot", text: "50 сомони", imageUrl: null, at: botRow.createdAt.toISOString() },
    ]);
    const after = db.model("message").findMany.mock.calls.at(-1)?.[0] as { where: { createdAt: { gt: Date } } };
    expect(after.where.createdAt.gt).toEqual(t0);

    const owner = { ...botRow, id: "m-owner", byHuman: true, text: "Это Ширин" };
    db.model("message").findMany.mockResolvedValue([owner]);
    const poll = await fetch(`${base}/api/site/chat/poll?after=m-out`, {
      headers: { cookie: `ssb_visitor=${cookie}` },
    });
    const polled = (await poll.json()) as { messages: { from: string }[]; typing?: boolean };
    expect(polled.messages[0].from).toBe("owner");
    // ИИ уже отработал — typing больше не выставлен для этого контакта.
    expect(polled.typing).toBeUndefined();
  });

  it("poll: typing:true, пока фоновая генерация ИИ не завершилась", async () => {
    const visitorId = issueVisitorId();
    const cookie = encodeVisitorCookie(visitorId);
    const contact = webContact(visitorId);
    db.model("contact").upsert.mockResolvedValue(contact);
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("message").findMany.mockResolvedValue([]);
    const echo = {
      id: "m-typing",
      direction: "IN",
      byHuman: false,
      text: "Привет",
      imageUrl: null,
      createdAt: new Date(),
    };
    db.model("message").create.mockResolvedValue(echo);

    let releaseAi!: () => void;
    aiReply.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseAi = resolve)));

    const send = await post("/api/site/chat/send", { text: "Привет" }, cookie);
    expect((await send.json()) as { pending?: boolean }).toMatchObject({ pending: true });

    const pollWhileTyping = await fetch(`${base}/api/site/chat/poll?after=m-typing`, {
      headers: { cookie: `ssb_visitor=${cookie}` },
    });
    expect((await pollWhileTyping.json()) as { typing?: boolean }).toMatchObject({ typing: true });

    releaseAi();
    await vi.waitFor(async () => {
      const pollAfter = await fetch(`${base}/api/site/chat/poll?after=m-typing`, {
        headers: { cookie: `ssb_visitor=${cookie}` },
      });
      const finalBody = (await pollAfter.json()) as { typing?: boolean };
      expect(finalBody.typing).toBeUndefined();
    });
  });

  it("send без текста и картинки — 400; poll без контакта — пусто", async () => {
    const cookie = encodeVisitorCookie(issueVisitorId());
    const bad = await post("/api/site/chat/send", {}, cookie);
    expect(bad.status).toBe(400);
    expect(aiReply).not.toHaveBeenCalled();

    const poll = await fetch(`${base}/api/site/chat/poll`);
    expect(await poll.json()).toEqual({ messages: [] });
  });

  it("подделанная кука — новый посетитель, а не чужая переписка", async () => {
    const victim = issueVisitorId();
    const forged = `${victim}.${"0".repeat(32)}`;
    db.model("contact").upsert.mockImplementation(async (args: unknown) => {
      const { create } = args as { create: { igUserId: string } };
      return webContact(create.igUserId);
    });
    db.model("message").findMany.mockResolvedValue([]);
    const res = await post("/api/site/chat/start", { lang: "ru" }, forged);
    const body = (await res.json()) as { visitorId: string };
    expect(body.visitorId).not.toBe(victim);
    expect(cookieOf(res)).toMatch(new RegExp(`^${body.visitorId}\\.`));
  });

  it("лимит 20 сообщений за 10 минут на посетителя → 429 с retryAfterSec", async () => {
    const visitorId = issueVisitorId();
    const cookie = encodeVisitorCookie(visitorId);
    const contact = webContact(visitorId);
    db.model("contact").upsert.mockResolvedValue(contact);
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("message").create.mockResolvedValue({
      id: "m",
      direction: "IN",
      byHuman: false,
      text: "x",
      imageUrl: null,
      createdAt: new Date(),
    });
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date() });
    db.model("message").findMany.mockResolvedValue([]);
    for (let i = 0; i < 20; i++) {
      const res = await post("/api/site/chat/send", { text: `сообщение ${i}` }, cookie);
      expect(res.status).toBe(200);
    }
    const blocked = await post("/api/site/chat/send", { text: "ещё" }, cookie);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await blocked.json()) as { error: string; retryAfterSec: number };
    expect(body.retryAfterSec).toBeGreaterThan(0);
    await vi.waitFor(() => expect(aiReply).toHaveBeenCalledTimes(20));
  });

  it("offline-signup: валидация, заявка в переписку, карточка владельцу, лимит 3/час на IP", async () => {
    const cookie = encodeVisitorCookie(issueVisitorId());
    const invalid = await post("/api/site/offline-signup", { name: "М", phone: "12", lang: "ru" }, cookie);
    expect(invalid.status).toBe(400);
    expect(notifyOwnerDirect).not.toHaveBeenCalled();

    const contact = webContact("v");
    db.model("contact").upsert.mockResolvedValue(contact);
    db.model("contact").update.mockResolvedValue(contact);
    db.model("offlineSignup").findUnique.mockResolvedValue(null);
    db.model("offlineSignup").create.mockResolvedValue({ id: "s1" });

    const ok = await post("/api/site/offline-signup", { name: "Мадина", phone: "+992 900 112233", lang: "tg" }, cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const msg = db.model("message").create.mock.calls[0][0] as { data: { direction: string; text: string } };
    expect(msg.data).toMatchObject({ direction: "IN", text: "Заявка на офлайн-курс: Мадина, +992 900 112233" });
    const signup = db.model("offlineSignup").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(signup.data).toMatchObject({ contactId: "contact-web", name: "Мадина", phone: "+992 900 112233" });
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    const card = notifyOwnerDirect.mock.calls[0][0] as unknown as string;
    expect(card).toContain("Мадина");
    expect(card).toContain("+992 900 112233");

    await post("/api/site/offline-signup", { name: "Мадина", phone: "900112233" }, cookie);
    await post("/api/site/offline-signup", { name: "Мадина", phone: "900112233" }, cookie);
    const fourth = await post("/api/site/offline-signup", { name: "Мадина", phone: "900112233" }, cookie);
    expect(fourth.status).toBe(429);
  });

  it("offline-signup accepts formatted phones like the UI and rejects misplaced plus signs", async () => {
    const contact = webContact("formatted");
    db.model("contact").upsert.mockResolvedValue(contact);
    db.model("offlineSignup").findUnique.mockResolvedValue(null);
    db.model("offlineSignup").create.mockResolvedValue({ id: "formatted" });
    expect((await post("/api/site/offline-signup", { name: "Мадина", phone: "+++905355355" })).status).toBe(400);
    expect(db.model("contact").upsert).not.toHaveBeenCalled();
    const formatted = "+992 (90) 535-53-55";
    expect((await post("/api/site/offline-signup", { name: "Мадина", phone: formatted })).status).toBe(200);
    expect(db.model("offlineSignup").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phone: formatted }) }),
    );
  });
});
