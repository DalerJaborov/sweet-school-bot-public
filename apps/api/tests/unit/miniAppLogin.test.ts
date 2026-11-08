import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const BOT_TOKEN = "123456:TEST-bot-token";
const OWNER = "1001";
const SISTER = "1002";
const settings: Record<string, string> = {
  telegramBotToken: BOT_TOKEN,
  telegramOwnerChatId: OWNER,
  telegramReportChatId: SISTER,
};
vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async (key: string) => settings[key] ?? null),
  logError: vi.fn(),
  prisma: {},
}));

import { miniAppRouter, resetMiniAppLimits } from "../../src/miniApp.js";
import { adminLoginRouter, adminTokenSecret, isAdminToken, passwordGate } from "../../src/adminLogin.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";
import { adminAccessConfig, createAdminAccessGuard } from "../../src/adminAccess.js";

/** Подпись ровно по правилам Telegram (core.telegram.org/bots/webapps). */
function initData(userId: string, opts: { ageSec?: number; token?: string; tamper?: boolean } = {}): string {
  const authDate = Math.floor(Date.now() / 1000) - (opts.ageSec ?? 5);
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAH-test",
    user: JSON.stringify({ id: Number(userId), first_name: "T" }),
  });
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(opts.token ?? BOT_TOKEN)
    .digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  if (opts.tamper) params.set("user", JSON.stringify({ id: Number(OWNER) }));
  return params.toString();
}

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(
    ["/admin", "/admin-form"],
    createAdminAccessGuard(adminAccessConfig({ NODE_ENV: "production", SCHOOL_ACCESS_REQUIRED: "0" }), {
      has: async () => false,
      add: async () => {},
    }),
  );
  app.use(express.json());
  app.use(miniAppRouter);
  app.use(adminLoginRouter);
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  resetMiniAppLimits();
  passwordGate.reset();
  delete process.env.SCHOOL_ACCESS_REQUIRED;
});

const login = (data: string) =>
  fetch(base + "/admin/telegram-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: data }),
  });

describe("вход в мини-апп по подписи Telegram", () => {
  it("пускает владельца и сестру и выдаёт админский токен", async () => {
    for (const id of [OWNER, SISTER]) {
      const res = await login(initData(id));
      expect(res.status).toBe(200);
      const claims = jwt.verify(((await res.json()) as { token: string }).token, adminTokenSecret()) as Record<
        string,
        unknown
      >;
      expect(claims.role).toBe("admin");
      expect(claims.tgId).toBe(id);
    }
  });
  it("не пускает чужой Telegram-аккаунт с верной подписью", async () => {
    expect((await login(initData("999"))).status).toBe(403);
  });
  it("не пускает подделку: подпись чужим токеном, подмена пользователя, нет hash", async () => {
    expect((await login(initData(OWNER, { token: "666:other" }))).status).toBe(403);
    expect((await login(initData("999", { tamper: true }))).status).toBe(403);
    expect((await login("auth_date=1&user=%7B%22id%22%3A1001%7D")).status).toBe(403);
    expect((await login("")).status).toBe(400);
  });
  it("не пускает просроченную подпись (старше суток)", async () => {
    expect((await login(initData(OWNER, { ageSec: 2 * 3600 }))).status).toBe(403);
    expect((await login(initData(OWNER, { ageSec: -3600 }))).status).toBe(403);
  });
  it("в режиме Cloudflare Access вход через Telegram закрыт", async () => {
    process.env.SCHOOL_ACCESS_REQUIRED = "1";
    expect((await login(initData(OWNER))).status).toBe(403);
  });
  it("после череды попыток отвечает 429", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await login(initData("999"))).status;
    expect(last).toBe(429);
  });
});

describe("режим входа в бою", () => {
  it("в бою режим нужно задавать явно", () => {
    expect(() => adminAccessConfig({ NODE_ENV: "production" })).toThrow();
    expect(adminAccessConfig({ NODE_ENV: "production", SCHOOL_ACCESS_REQUIRED: "0" })).toBeNull();
  });
  it("сайт сообщает режим «пароль/Telegram»", async () => {
    const res = await fetch(base + "/admin/session");
    expect(await res.json()).toEqual({ mode: "password" });
  });
});

const pw = (password: string, headers: Record<string, string> = {}) => fetch(base + "/admin/login", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ password }) });

describe("вход по паролю в браузере", () => {
  it("верный пароль даёт админский токен, неверный — 401", async () => {
    const ok = await pw(process.env.ADMIN_PASSWORD!);
    expect(ok.status).toBe(200);
    expect(isAdminToken(((await ok.json()) as { token: string }).token)).toBe(true);
    expect((await pw("wrong")).status).toBe(401);
  });
  it("после 8 неверных попыток адрес блокируется (429)", async () => {
    for (let i = 0; i < 8; i++) expect((await pw("wrong")).status).toBe(401);
    expect((await pw("wrong")).status).toBe(429);
  });
  it("мусор с подделанным заголовком адреса не запирает вход настоящему адресу", async () => {
    for (let i = 0; i < 30; i++) await pw("wrong", { "cf-connecting-ip": `not-an-ip-${i}` });
    expect((await pw(process.env.ADMIN_PASSWORD!)).status).toBe(200);
  });
  it("в режиме Cloudflare Access пароль закрыт", async () => {
    process.env.SCHOOL_ACCESS_REQUIRED = "1";
    // adminAccessConfig() в режиме 1 без остальных переменных падает: закрыто в любом случае
    const res = await pw(process.env.ADMIN_PASSWORD!).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
  });
});

describe("какие токены открывают панель", () => {
  const jwtLib = jwt;
  it("токен ученицы, токен старым общим секретом и токен без роли — не админские", () => {
    const secret = process.env.JWT_SECRET!;
    expect(isAdminToken(jwtLib.sign({ role: "admin" }, secret))).toBe(false); // старый секрет (до релиза)
    expect(isAdminToken(jwtLib.sign({ kind: "course-session" }, courseTokenSecret()))).toBe(false);
    expect(isAdminToken(jwtLib.sign({ role: "admin" }, courseTokenSecret()))).toBe(false);
    expect(isAdminToken("garbage")).toBe(false);
  });
  it("верный вход из Telegram приводит в токен, который панель признаёт", async () => {
    const res = await login(initData(OWNER));
    expect(isAdminToken(((await res.json()) as { token: string }).token)).toBe(true);
  });
  it("полученный раньше пустой белый список не пускает никого", async () => {
    settings.telegramOwnerChatId = ""; settings.telegramReportChatId = "";
    try { expect((await login(initData(""))).status).toBe(403); }
    finally { settings.telegramOwnerChatId = OWNER; settings.telegramReportChatId = SISTER; }
  });
});

describe("защита счётчика неудач", () => {
  it("карта ограничена, массив не растёт, переполнение не снимает блокировку", async () => {
    const { createFailureGate } = await import("../../src/adminLogin.js");
    const g = createFailureGate(3, { maxKeys: 5 });
    for (let i = 0; i < 50; i++) g.fail(`1.1.1.${i}`);
    expect(g.blocked("9.9.9.9")).toBe(true); // всё ушло в общий ключ "invalid" и он заблокирован
    const solo = createFailureGate(3);
    solo.fail("a"); solo.fail("a"); expect(solo.blocked("a")).toBe(false);
    solo.fail("a"); expect(solo.blocked("a")).toBe(true);
    expect(solo.blocked("a", Date.now() + 16 * 60_000)).toBe(false);
  });
  it("общий потолок неудач пароля закрывает только пароль", async () => {
    const { createFailureGate } = await import("../../src/adminLogin.js");
    const g = createFailureGate(8, { allLimit: 10 });
    for (let i = 0; i < 10; i++) g.fail(`2.2.2.${i}`);
    expect(g.blocked("3.3.3.3")).toBe(true);
  });
});
