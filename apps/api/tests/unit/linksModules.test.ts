import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import {
  SITE_LANGS,
  SITE_SOURCES,
  SITE_TARGETS,
  isPreviewAgent,
  newCode,
  redirectPath,
  rememberContactSource,
} from "../../src/links/siteLinks.js";
import { classifyFailure, inviteStatus, redactBotToken } from "../../src/links/telegramInvites.js";
import { handleChatMember } from "../../src/groupAccess.js";
import { logInfo } from "../../src/db.js";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

describe("redirectPath — только свои страницы", () => {
  it("каждая страница × язык × источник даёт путь этого сайта", () => {
    for (const target of SITE_TARGETS)
      for (const lang of SITE_LANGS)
        for (const source of SITE_SOURCES) {
          const out = redirectPath({ code: "abc234", target, lang, source, label: "x" });
          expect(out).toMatch(/^\/(?![/\\])/);
          expect(out).toContain("utm_content=abc234");
        }
  });
  it("комплект ведёт на витрину главной, метки — до якоря", () => {
    expect(redirectPath({ code: "k2k2k2", target: "bundle", lang: "tg", source: "tiktok", label: null })).toBe(
      "/?utm_source=tiktok&utm_medium=social&utm_campaign=bundle&utm_content=k2k2k2#online",
    );
  });
});

describe("кто не человек", () => {
  it("предпросмотры и роботы — не переход, телефоны и встроенные браузеры — переход", () => {
    for (const ua of [
      "facebookexternalhit/1.1",
      "TelegramBot (like TwitterBot)",
      "WhatsApp/2.23",
      "Googlebot/2.1",
      "curl/8.0",
      undefined,
      "",
    ])
      expect(isPreviewAgent(ua), String(ua)).toBe(true);
    for (const ua of [
      "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone) Mobile/15E148 Instagram 300.0",
      "Mozilla/5.0 (Linux; Android 13) musical_ly_2023 BytedanceWebview",
      "Mozilla/5.0 (iPhone) FBAN/FBIOS",
    ])
      expect(isPreviewAgent(ua), ua).toBe(false);
  });
  it("код из понятных знаков нужной длины", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
  });
});

describe("ответы Telegram → простые слова", () => {
  it("классифицирует частые отказы", () => {
    expect(
      classifyFailure({ code: 400, description: "Bad Request: not enough rights to manage chat invite links" }),
    ).toBe("no_rights");
    expect(classifyFailure({ code: 400, description: "Bad Request: CHAT_ADMIN_REQUIRED" })).toBe("no_rights");
    expect(classifyFailure({ code: 403, description: "Forbidden: bot was kicked from the supergroup chat" })).toBe(
      "not_member",
    );
    expect(classifyFailure({ code: 400, description: "Bad Request: chat not found" })).toBe("not_member");
    expect(
      classifyFailure({ code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat" }),
    ).toBe("group_moved");
    expect(classifyFailure({ code: 401, description: "Unauthorized" })).toBe("bad_token");
    expect(classifyFailure({ code: 429, description: "Too Many Requests: retry after 5" })).toBe("unavailable");
    expect(classifyFailure({ description: "fetch failed", network: true })).toBe("unavailable");
  });
  it("токен бота вырезается из текста", () => {
    const leaked =
      "fetch failed https://api.telegram.org/bot123456789:AAHsecretPartThatMustNeverLeak/createChatInviteLink";
    expect(redactBotToken(leaked)).not.toContain("AAHsecret");
  });
  it("общий журнал тоже не пишет токен бота (класс утечки, db.ts redact)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logInfo("test", "https://api.telegram.org/bot123456789:AAHsecretPartThatMustNeverLeak/sendMessage");
    expect(log.mock.calls.flat().join(" ")).not.toContain("AAHsecret");
  });
  it("статус приглашения", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const base = { revokedAt: null, expiresAt: new Date("2026-11-09T00:00:00Z"), memberLimit: 1, joinedCount: 0 };
    expect(inviteStatus(base, now)).toBe("active");
    expect(inviteStatus({ ...base, joinedCount: 1 }, now)).toBe("used");
    expect(inviteStatus({ ...base, expiresAt: new Date("2026-11-08T00:00:00Z") }, now)).toBe("expired");
    expect(inviteStatus({ ...base, revokedAt: now }, now)).toBe("revoked");
  });
});

describe("вход по ссылке из панели (chat_member)", () => {
  let db: PrismaMock;
  const telegramCalls: string[] = [];
  beforeEach(() => {
    db = mockPrisma();
    telegramCalls.length = 0;
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      ({ telegramBotToken: "1:abc", telegramOwnerChatId: "777", telegramChatId50: "-1001" })[where.key]
        ? {
            value: (
              { telegramBotToken: "1:abc", telegramOwnerChatId: "777", telegramChatId50: "-1001" } as Record<
                string,
                string
              >
            )[where.key],
          }
        : null,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      telegramCalls.push(String(input).split("/").pop() ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  afterEach(restorePrisma);

  const update = (link: string) => ({
    invite_link: { invite_link: link, creator: { id: 1, is_bot: true } },
    new_chat_member: { status: "member", user: { id: 42, first_name: "Мадина" } },
    chat: { id: -1001 },
  });

  it("ссылка на одну ученицу: без тревоги, вход засчитан, Telegram связан с карточкой", async () => {
    db.model("telegramInvite").findUnique.mockResolvedValue({
      id: "inv-1",
      groupKey: "COURSE50",
      contactId: "c-1",
      memberLimit: 1,
    });
    await handleChatMember(update("https://t.me/+Panel"));
    expect(telegramCalls).not.toContain("sendMessage");
    expect(db.model("telegramInvite").update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { joinedCount: { increment: 1 }, lastJoinedAt: expect.any(Date) },
    });
    expect(db.model("contact").updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", telegramUserId: null },
      data: { telegramUserId: "42" },
    });
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith({
      where: { contactId: "c-1", course: "COURSE50", joinedAt: null, revokedAt: null },
      data: { joinedAt: expect.any(Date) },
    });
  });

  it("ссылка на пятерых не привязывает вошедшего к одной ученице", async () => {
    db.model("telegramInvite").findUnique.mockResolvedValue({
      id: "inv-2",
      groupKey: "COURSE50",
      contactId: "c-1",
      memberLimit: 5,
    });
    await handleChatMember(update("https://t.me/+Five"));
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("незнакомая ботовая ссылка по-прежнему поднимает тревогу", async () => {
    db.model("telegramInvite").findUnique.mockResolvedValue(null);
    db.model("contact").findFirst.mockResolvedValue(null);
    await handleChatMember(update("https://t.me/+Leaked"));
    expect(telegramCalls).toContain("sendMessage");
  });
});

describe("источник заявки с сайта", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);
  const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

  it("кука ссылки → контакт помечается один раз", async () => {
    db.model("siteLink").findUnique.mockResolvedValue({ id: "link-1" });
    await rememberContactSource({ id: "c-1", siteLinkId: null }, req("a=1; ssb_src=abc234"));
    expect(db.model("contact").updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", siteLinkId: null },
      data: { siteLinkId: "link-1" },
    });
  });
  it("уже есть источник, нет куки или кука испорчена — ничего не пишем", async () => {
    await rememberContactSource({ id: "c-1", siteLinkId: "old" }, req("ssb_src=abc234"));
    await rememberContactSource({ id: "c-1", siteLinkId: null }, req());
    await rememberContactSource({ id: "c-1", siteLinkId: null }, req("ssb_src=' OR 1=1"));
    expect(db.model("siteLink").findUnique).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
});

/**
 * СТОРОЖ «ОДНОЙ ДВЕРИ». Ссылки-приглашения в группы создаются и гасятся только
 * в трёх известных местах, а таблицы ссылок раздела читаются и пишутся только
 * модулем links/. Новый обход — красный тест, а не тихая вторая дверь.
 */
describe("архитектура: одна дверь для ссылок", () => {
  const src = path.resolve(__dirname, "../../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(src);
  const rel = (p: string) => path.relative(src, p).replace(/\\/g, "/");

  it("createChatInviteLink/revokeChatInviteLink — только telegram.ts, groupAccess.ts, links/telegramInvites.ts", () => {
    const allowed = new Set(["telegram.ts", "groupAccess.ts", "links/telegramInvites.ts"]);
    const offenders = files.filter(
      (f) => /(create|revoke)ChatInviteLink/.test(fs.readFileSync(f, "utf8")) && !allowed.has(rel(f)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
  it("prisma.siteLink / prisma.telegramInvite — только внутри links/", () => {
    const offenders = files.filter(
      (f) => /prisma\.(siteLink|telegramInvite)\b/.test(fs.readFileSync(f, "utf8")) && !rel(f).startsWith("links/"),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});
