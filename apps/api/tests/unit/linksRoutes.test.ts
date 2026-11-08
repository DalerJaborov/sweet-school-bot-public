import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { signAdminToken } from "../../src/adminLogin.js";
import { adminRouter } from "../../src/admin.js";
import { goRouter, resetGoLimits } from "../../src/links/siteLinks.js";
import { resetLinksLimits } from "../../src/links/routes.js";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * Раздел «Ссылки»: права, создание, переход /go/<код>, счётчик, защита от
 * открытого перенаправления и выдача приглашений в Telegram на моке Bot API.
 */

const BOT_TOKEN = "123456789:AAHsecretPartThatMustNeverLeak_xyz";
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0";

let server: Server;
let base: string;
const token = signAdminToken();
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(goRouter);
  app.use(adminRouter);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ error: "test failure" }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let db: PrismaMock;
let settings: Record<string, string>;
let telegram: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetGoLimits();
  resetLinksLimits();
  db = mockPrisma();
  settings = { telegramBotToken: BOT_TOKEN, telegramChatId50: "-1001", telegramChatId70: "-1002" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] != null ? { key: where.key, value: settings[where.key] } : null,
  );
  telegram = vi.fn(async () => ({ ok: true, result: { invite_link: "https://t.me/+NewInvite123" } }));
  // Сеть к Telegram подменяем, к нашему тестовому серверу — пропускаем как есть.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(await telegram(method, body)));
    }
    return realFetch(input, init);
  });
});
afterEach(restorePrisma);

const call = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) =>
  realFetch(`${base}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(init.auth === false ? {} : { authorization: `Bearer ${token}` }),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

const go = (code: string, ua = BROWSER, ip = "10.0.0.1") =>
  realFetch(`${base}/go/${code}`, { redirect: "manual", headers: { "user-agent": ua, "x-forwarded-for": ip } });

const link = (over: Record<string, unknown> = {}) => ({
  id: "link-1",
  code: "abc234",
  target: "online",
  lang: "ru",
  source: "blogger",
  label: "Мадина",
  clicks: 0,
  lastClickAt: null,
  createdAt: new Date(),
  ...over,
});

describe("права", () => {
  it("без входа — 401 на все маршруты раздела", async () => {
    for (const [path, method] of [
      ["/admin/v1/links/options", "GET"],
      ["/admin/v1/links/site", "GET"],
      ["/admin/v1/links/site", "POST"],
      ["/admin/v1/links/telegram", "GET"],
      ["/admin/v1/links/telegram", "POST"],
      ["/admin/v1/links/telegram/x/revoke", "POST"],
    ] as const) {
      const res = await call(path, { method, auth: false, body: method === "POST" ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(db.model("siteLink").create).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
  });
});

describe("ссылка на сайт", () => {
  it("создаёт короткую ссылку /go/<код>", async () => {
    db.model("siteLink").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => link(data));
    const res = await call("/admin/v1/links/site", {
      body: { target: "art", lang: "tg", source: "blogger", label: "  Мадина  " },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { link: { url: string; code: string } };
    expect(body.link.url).toMatch(/\/go\/[a-z2-9]{6}$/);
    const data = db.model("siteLink").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.data).toMatchObject({ target: "art", lang: "tg", source: "blogger", label: "Мадина" });
  });

  it("блогер без имени — понятная ошибка, ничего не создано", async () => {
    const res = await call("/admin/v1/links/site", { body: { target: "home", lang: "tg", source: "blogger" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("имя блогера");
    expect(db.model("siteLink").create).not.toHaveBeenCalled();
  });

  it("чужой адрес вместо страницы не принимается", async () => {
    for (const target of ["https://evil.example", "//evil.example", "/admin"]) {
      const res = await call("/admin/v1/links/site", { body: { target, lang: "ru", source: "instagram" } });
      expect(res.status).toBe(400);
    }
    expect(db.model("siteLink").create).not.toHaveBeenCalled();
  });

  it("для Instagram имя не сохраняется (поле только для блогера и рекламы)", async () => {
    db.model("siteLink").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => link(data));
    await call("/admin/v1/links/site", { body: { target: "home", lang: "tg", source: "instagram", label: "лишнее" } });
    const data = db.model("siteLink").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.data.label).toBeNull();
  });

  it("не больше 30 ссылок за 10 минут", async () => {
    db.model("siteLink").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => link(data));
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (await call("/admin/v1/links/site", { body: { target: "home", lang: "tg", source: "tiktok" } })).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("список считает переходы, обращения и покупки", async () => {
    db.model("siteLink").findMany.mockResolvedValue([link({ clicks: 12 })]);
    db.model("contact").groupBy.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.purchases
        ? [{ siteLinkId: "link-1", _count: { _all: 1 } }]
        : [{ siteLinkId: "link-1", _count: { _all: 3 } }],
    );
    db.model("freeLessonLead").groupBy.mockResolvedValue([{ siteLinkId: "link-1", _count: { _all: 2 } }]);
    const res = await call("/admin/v1/links/site");
    const body = (await res.json()) as { links: Record<string, unknown>[] };
    expect(body.links[0]).toMatchObject({
      clicks: 12,
      leads: 5,
      buyers: 1,
      sourceLabel: "Блогер",
      targetLabel: "Онлайн-курс",
    });
  });
});

describe("переход /go/<код>", () => {
  it("302 на свою страницу с метками, кука источника и +1 переход", async () => {
    db.model("siteLink").findUnique.mockResolvedValue(link());
    const res = await go("abc234");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/online-kurs?utm_source=blogger&utm_medium=influencer&utm_campaign=%D0%9C%D0%B0%D0%B4%D0%B8%D0%BD%D0%B0&utm_content=abc234",
    );
    expect(res.headers.get("set-cookie")).toContain("ssb_src=abc234");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(db.model("siteLink").update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { clicks: { increment: 1 }, lastClickAt: expect.any(Date) },
    });
  });

  it("повторный клик того же человека за полчаса не считается, другой человек — считается", async () => {
    db.model("siteLink").findUnique.mockResolvedValue(link());
    await go("abc234", BROWSER, "10.0.0.2");
    await go("abc234", BROWSER, "10.0.0.2");
    expect(db.model("siteLink").update).toHaveBeenCalledTimes(1);
    await go("abc234", BROWSER, "10.0.0.3");
    expect(db.model("siteLink").update).toHaveBeenCalledTimes(2);
  });

  it("предпросмотр мессенджеров не считается, но перенаправляется", async () => {
    db.model("siteLink").findUnique.mockResolvedValue(link());
    for (const ua of ["facebookexternalhit/1.1", "TelegramBot (like TwitterBot)", "WhatsApp/2.23.20.0 A", ""]) {
      const res = await go("abc234", ua, `10.1.0.${ua.length}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(db.model("siteLink").update).not.toHaveBeenCalled();
  });

  it("неизвестный и кривой код — на главную, без обращения к базе для кривого", async () => {
    db.model("siteLink").findUnique.mockResolvedValue(null);
    const unknown = await go("zzzzzz");
    expect(unknown.headers.get("location")).toBe("/");
    db.model("siteLink").findUnique.mockClear();
    for (const bad of ["%2F%2Fevil.example", "ab", "https:%2F%2Fevil.example", "a.b.c"]) {
      const res = await go(bad);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
    expect(db.model("siteLink").findUnique).not.toHaveBeenCalled();
  });

  it("испорченная строка в базе всё равно уводит только на свой сайт", async () => {
    for (const target of ["https://evil.example", "//evil.example", "/\\evil.example", "home"]) {
      db.model("siteLink").findUnique.mockResolvedValue(link({ target, source: "nonsense", lang: "xx" }));
      const res = await go("abc234", BROWSER, `10.2.0.${target.length}`);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("/")).toBe(true);
      expect(location.startsWith("//")).toBe(false);
      expect(location.startsWith("/\\")).toBe(false);
      expect(location).not.toContain("evil");
    }
  });

  it("поток запросов с одного адреса не доходит до базы", async () => {
    db.model("siteLink").findUnique.mockResolvedValue(link());
    for (let i = 0; i < 65; i++) await go("abc234", BROWSER, "10.9.9.9");
    expect(db.model("siteLink").findUnique).toHaveBeenCalledTimes(60);
  });
});

describe("приглашение в Telegram", () => {
  it("создаёт ссылку на один вход в группу выбранного курса и запоминает её", async () => {
    db.model("telegramInvite").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "inv-1",
      ...data,
    }));
    const res = await call("/admin/v1/links/telegram", { body: { group: "COURSE70", preset: "one", name: "Мадина" } });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain("https://t.me/+NewInvite123");
    expect(text).not.toContain("AAHsecret");
    const [method, body] = telegram.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("createChatInviteLink");
    expect(body).toMatchObject({ chat_id: "-1002", member_limit: 1, name: "Мадина" });
    expect(Number(body.expire_date)).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    const saved = db.model("telegramInvite").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(saved.data).toMatchObject({
      groupKey: "COURSE70",
      chatId: "-1002",
      inviteLink: "https://t.me/+NewInvite123",
      memberLimit: 1,
    });
  });

  it("у бота нет права приглашать — подсказка простыми словами, токен нигде не виден", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    telegram.mockResolvedValue({
      ok: false,
      error_code: 400,
      description: "Bad Request: not enough rights to manage chat invite links",
    });
    const res = await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "one" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe("no_rights");
    expect(body.error).toContain("администратором");
    expect(body.error).toContain("Приглашать участников");
    expect(db.model("telegramInvite").create).not.toHaveBeenCalled();
    const logged = [...errors.mock.calls, ...warnings.mock.calls].flat().join(" ");
    // Настройку группы видно в журнале как предупреждение, а не тревогу.
    expect(warnings.mock.calls.flat().join(" ")).toContain("not enough rights");
    expect(logged).not.toContain("AAHsecret");
  });

  it("бота нет в группе / токен не принят / нет сети — каждая причина своими словами", async () => {
    telegram.mockResolvedValueOnce({
      ok: false,
      error_code: 403,
      description: "Forbidden: bot is not a member of the supergroup chat",
    });
    let body = (await (
      await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "one" } })
    ).json()) as { reason: string };
    expect(body.reason).toBe("not_member");
    telegram.mockResolvedValueOnce({ ok: false, error_code: 401, description: "Unauthorized" });
    body = (await (await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "one" } })).json()) as {
      reason: string;
    };
    expect(body.reason).toBe("bad_token");
    telegram.mockRejectedValueOnce(new TypeError(`fetch failed https://api.telegram.org/bot${BOT_TOKEN}/x`));
    const res = await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "one" } });
    expect(res.status).toBe(503);
  });

  it("не задан токен или ID группы — Telegram даже не вызывается", async () => {
    delete settings.telegramChatId50;
    let body = (await (
      await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "one" } })
    ).json()) as { reason: string };
    expect(body.reason).toBe("no_group");
    delete settings.telegramBotToken;
    body = (await (await call("/admin/v1/links/telegram", { body: { group: "COURSE70", preset: "one" } })).json()) as {
      reason: string;
    };
    expect(body.reason).toBe("no_bot");
    expect(telegram).not.toHaveBeenCalled();
  });

  it("неизвестная группа или набор — 400", async () => {
    const res = await call("/admin/v1/links/telegram", { body: { group: "-100999", preset: "one" } });
    expect(res.status).toBe(400);
    const res2 = await call("/admin/v1/links/telegram", { body: { group: "COURSE50", preset: "1000" } });
    expect(res2.status).toBe(400);
  });

  it("отзыв: Telegram гасит ссылку в той группе, где она создана", async () => {
    db.model("telegramInvite").findUnique.mockResolvedValue({
      id: "inv-1",
      groupKey: "COURSE50",
      chatId: "-100old",
      inviteLink: "https://t.me/+Old",
      revokedAt: null,
    });
    telegram.mockResolvedValue({ ok: true, result: { invite_link: "https://t.me/+Old", is_revoked: true } });
    const res = await call("/admin/v1/links/telegram/inv-1/revoke", { method: "POST" });
    expect(res.status).toBe(200);
    expect(telegram).toHaveBeenCalledWith("revokeChatInviteLink", {
      chat_id: "-100old",
      invite_link: "https://t.me/+Old",
    });
    expect(db.model("telegramInvite").updateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("отзыв без прав — ссылка не помечается отозванной", async () => {
    db.model("telegramInvite").findUnique.mockResolvedValue({
      id: "inv-1",
      groupKey: "COURSE50",
      chatId: "-1001",
      inviteLink: "https://t.me/+Old",
      revokedAt: null,
    });
    telegram.mockResolvedValue({ ok: false, error_code: 400, description: "Bad Request: CHAT_ADMIN_REQUIRED" });
    const res = await call("/admin/v1/links/telegram/inv-1/revoke", { method: "POST" });
    expect(res.status).toBe(409);
    expect(db.model("telegramInvite").updateMany).not.toHaveBeenCalled();
  });
});
