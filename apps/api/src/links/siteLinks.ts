import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { prisma, logError } from "../db.js";
import { env } from "../env.js";
import { clientIp } from "../course/access.js";
import { createRateLimiter } from "../services/rateLimit.js";

/**
 * КОРОТКИЕ ССЫЛКИ НА САЙТ ДЛЯ РЕКЛАМЫ И БЛОГЕРОВ (раздел «Ссылки», 08.11.2026).
 *
 * Хозяйка создаёт в панели ссылку «куда ведёт × откуда пришли» и получает
 * https://shirinsweets.online/go/<код>. Переход по ней:
 *  1. считает клик (без личных данных — только число и время последнего);
 *  2. кладёт посетителю куку ssb_src=<код> на 30 дней — по ней заявка с сайта
 *     (чат, запись на очный курс, бесплатный урок) запоминает, с какой рекламы
 *     человек пришёл, а покупка видна через его контакт;
 *  3. уводит 302 на страницу сайта с UTM-метками.
 *
 * ОТКРЫТОГО РЕДИРЕКТА НЕТ ПО УСТРОЙСТВУ: в базе хранится не адрес, а ключ из
 * закрытого списка (target), путь собирается здесь из таблицы PATHS и всегда
 * начинается с одного «/». Даже испорченная строка в базе уводит на главную.
 *
 * Эта дверь — единственная для ссылок сайта: создание, переход, учёт и чтение
 * источника заявки живут только здесь (сторож — tests/unit/linksModules.test.ts, «архитектура: одна дверь для ссылок»).
 */

export const SITE_TARGETS = ["home", "online", "art", "bundle", "offline"] as const;
export type SiteTarget = (typeof SITE_TARGETS)[number];
export const SITE_LANGS = ["tg", "ru"] as const;
export type SiteLang = (typeof SITE_LANGS)[number];
export const SITE_SOURCES = ["instagram", "tiktok", "telegram", "whatsapp", "blogger", "ads"] as const;
export type SiteSource = (typeof SITE_SOURCES)[number];

/** Источники, для которых нужно имя (какой блогер, какая реклама). */
export const SOURCES_WITH_LABEL: ReadonlySet<SiteSource> = new Set(["blogger", "ads"]);

export const TARGET_LABEL: Record<SiteTarget, string> = {
  home: "Главная страница",
  online: "Онлайн-курс",
  art: "Курс «Арт-десерты»",
  bundle: "Оба курса вместе",
  offline: "Очный курс в Душанбе",
};

export const SOURCE_LABEL: Record<SiteSource, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  blogger: "Блогер",
  ads: "Реклама",
};

/**
 * Страницы сайта. Таджикская — основная (корень «/»), русская — /ru/ и
 * страницы без префикса (см. apps/web/scripts/build-site-pages.mjs pageUrl).
 * «Оба курса» — витрина с комплектом на главной (секция id="online").
 */
const PATHS: Record<SiteTarget, Record<SiteLang, string>> = {
  home: { tg: "/", ru: "/ru/" },
  online: { tg: "/tg/online-kurs", ru: "/online-kurs" },
  art: { tg: "/tg/art-desserty", ru: "/art-desserty" },
  bundle: { tg: "/#online", ru: "/ru/#online" },
  offline: { tg: "/tg/kursy-konditera-dushanbe", ru: "/kursy-konditera-dushanbe" },
};

const UTM_MEDIUM: Record<SiteSource, string> = {
  instagram: "social",
  tiktok: "social",
  telegram: "social",
  whatsapp: "messenger",
  blogger: "influencer",
  ads: "paid",
};

export function isSiteTarget(v: unknown): v is SiteTarget {
  return typeof v === "string" && (SITE_TARGETS as readonly string[]).includes(v);
}
function isSource(v: unknown): v is SiteSource {
  return typeof v === "string" && (SITE_SOURCES as readonly string[]).includes(v);
}

// Без похожих знаков (l/1/i, o/0): код могут переписывать с экрана или с афиши.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_RE = /^[a-z2-9]{4,16}$/;

export function newCode(length = 6): string {
  let out = "";
  // Отбрасываем байты выше кратного длине алфавита — иначе первые буквы
  // выпадали бы чаще остальных.
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

type LinkShape = { code: string; target: string; lang: string; source: string; label: string | null };

/**
 * Куда уводит ссылка: всегда ВНУТРЕННИЙ путь сайта. Последняя проверка —
 * на случай будущей правки таблицы: «//evil.com» и «/\evil.com» браузер
 * понял бы как чужой сайт, поэтому такое превращается в главную.
 */
export function redirectPath(link: LinkShape): string {
  const target = isSiteTarget(link.target) ? link.target : "home";
  const lang: SiteLang = link.lang === "ru" ? "ru" : "tg";
  const [path, hash] = PATHS[target][lang].split("#");
  let out = path;
  if (isSource(link.source)) {
    const q = new URLSearchParams({
      utm_source: link.source,
      utm_medium: UTM_MEDIUM[link.source],
      utm_campaign: (link.label ?? "").trim().slice(0, 60) || target,
      utm_content: link.code,
    });
    out += `?${q.toString()}`;
  }
  if (hash) out += `#${hash}`;
  return /^\/(?![/\\])/.test(out) ? out : "/";
}

export function shortUrl(code: string): string {
  return `${env.publicBaseUrl}/go/${code}`;
}

export type SiteLinkInput = { target: SiteTarget; lang: SiteLang; source: SiteSource; label?: string | null };

export async function createSiteLink(input: SiteLinkInput) {
  const label = SOURCES_WITH_LABEL.has(input.source) ? (input.label ?? "").trim().slice(0, 60) || null : null;
  // Совпадение кода почти невозможно (31^6), но если случится — пробуем новый,
  // а не отдаём хозяйке ошибку.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.siteLink.create({
        data: { code: newCode(), target: input.target, lang: input.lang, source: input.source, label },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
    }
  }
  throw new Error("siteLinks: не удалось подобрать свободный код");
}

/** Телефон для сравнения: последние 9 цифр (с +992 и без — один номер). */
function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Список ссылок с переходами, обращениями и покупками по каждой.
 *
 * «Обратились» — ЛЮДИ, а не заявки: чат на сайте и запись на очный курс одного
 * посетителя — один контакт; заявка на бесплатный урок живёт отдельно и
 * считается, только если её телефона нет среди уже посчитанных (и сама с собой
 * не дублируется). «Купили» — только через чат на сайте: у пришедших в
 * WhatsApp или Instagram ссылки нет, их здесь не видно (экран это пишет).
 */
export async function listSiteLinks(take = 200) {
  const links = await prisma.siteLink.findMany({ orderBy: { createdAt: "desc" }, take });
  const ids = links.map((l) => l.id);
  const [contacts, freeLeads] = ids.length
    ? await Promise.all([
        prisma.contact.findMany({
          where: { siteLinkId: { in: ids } },
          select: {
            siteLinkId: true,
            offlineSignup: { select: { phone: true } },
            purchases: { where: { revokedAt: null }, select: { id: true }, take: 1 },
          },
        }),
        prisma.freeLessonLead.findMany({
          where: { siteLinkId: { in: ids } },
          select: { siteLinkId: true, phone: true },
        }),
      ])
    : [[], []];
  const stats = new Map<string, { people: number; buyers: number; phones: Set<string> }>();
  const of = (id: string) => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { people: 0, buyers: 0, phones: new Set() }));
    return s;
  };
  for (const c of contacts) {
    if (!c.siteLinkId) continue;
    const s = of(c.siteLinkId);
    s.people += 1;
    if (c.purchases.length > 0) s.buyers += 1;
    const key = phoneKey(c.offlineSignup?.phone);
    if (key) s.phones.add(key);
  }
  for (const lead of freeLeads) {
    if (!lead.siteLinkId) continue;
    const s = of(lead.siteLinkId);
    const key = phoneKey(lead.phone);
    if (key && s.phones.has(key)) continue;
    if (key) s.phones.add(key);
    s.people += 1;
  }
  return links.map((l) => ({
    id: l.id,
    code: l.code,
    url: shortUrl(l.code),
    target: l.target,
    targetLabel: isSiteTarget(l.target) ? TARGET_LABEL[l.target] : l.target,
    lang: l.lang,
    source: l.source,
    sourceLabel: isSource(l.source) ? SOURCE_LABEL[l.source] : l.source,
    label: l.label,
    clicks: l.clicks,
    leads: stats.get(l.id)?.people ?? 0,
    buyers: stats.get(l.id)?.buyers ?? 0,
    lastClickAt: l.lastClickAt,
    createdAt: l.createdAt,
  }));
}

// ---------- переход /go/<код> ----------

export const SOURCE_COOKIE = "ssb_src";
const SOURCE_TTL_DAYS = 30;

/**
 * Предпросмотр ссылок в мессенджерах и поисковые роботы открывают адрес сами,
 * без человека: Instagram, WhatsApp и Telegram делают это при КАЖДОЙ отправке.
 * Если их считать, у ссылки блогера «переходов» окажется больше, чем
 * подписчиков, которые реально нажали. Пустой агент — тоже не человек.
 * Список точечный, а не просто /bot/: телефоны CUBOT несут это слово в имени.
 * Яндекс и Pinterest — только их роботы (YandexBot…, Pinterestbot,
 * «Pinterest/0.x»): приложение Яндекса и приложение Pinterest — это люди.
 */
const PREVIEW_AGENT =
  /(facebookexternalhit|facebot|whatsapp\/|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|vkshare|pinterestbot|pinterest\/0\.|embedly|redditbot|applebot|googlebot|bingbot|yandex\w*bot|baiduspider|duckduckbot|petalbot|ahrefsbot|semrushbot|mj12bot|bytespider|crawler|spider|[a-z]bot\/|curl\/|wget\/|python-requests|go-http-client|headlesschrome)/i;

export function isPreviewAgent(userAgent: string | undefined): boolean {
  return !userAgent || PREVIEW_AGENT.test(userAgent);
}

/**
 * ОДИН IP — МНОГО ЛЮДЕЙ. Мобильные операторы Таджикистана выводят в интернет
 * тысячи абонентов через общий адрес, поэтому по IP здесь не решаем, кто
 * человек: повтор узнаём по куке, а адрес сдерживает только базу.
 *  • Ссылки держим в памяти: уже известный код ведёт на СВОЮ страницу при любой
 *    нагрузке, без похода в базу.
 *  • В базу за неизвестным кодом — не чаще 60 раз в минуту с адреса (перебор
 *    кодов); сверх того — на главную.
 *  • Запись счётчика — не чаще 120 в минуту с адреса и 1200 в минуту всего:
 *    сверх этого человек всё равно попадает на нужную страницу, переход просто
 *    не считается.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 2000;
type CachedLink = { id: string; code: string; path: string } | null;
const linkCache = new Map<string, { link: CachedLink; at: number }>();
const lookupPerIp = createRateLimiter({ limit: 60, windowMs: 60_000 });
const writesPerIp = createRateLimiter({ limit: 120, windowMs: 60_000 });
const writesTotal = createRateLimiter({ limit: 1200, windowMs: 60_000 });
export const CLICK_COOKIE = "ssb_click";
const CLICK_TTL_SEC = 30 * 60;

/** Только для тестов. */
export function resetGoLimits(): void {
  linkCache.clear();
  lookupPerIp.reset();
  writesPerIp.reset();
  writesTotal.reset();
}

function cached(code: string): CachedLink | undefined {
  const hit = linkCache.get(code);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    linkCache.delete(code);
    return undefined;
  }
  return hit.link;
}

function remember(code: string, link: CachedLink): void {
  if (linkCache.size >= CACHE_MAX) {
    const oldest = linkCache.keys().next().value;
    if (oldest !== undefined) linkCache.delete(oldest);
  }
  linkCache.set(code, { link, at: Date.now() });
}

/** Повторный клик того же человека за полчаса узнаём по куке, а не по IP. */
function clickCookie(code: string): string {
  const parts = [`${CLICK_COOKIE}=${code}`, "Path=/go/", "HttpOnly", "SameSite=Lax", `Max-Age=${CLICK_TTL_SEC}`];
  if (env.publicBaseUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

function sourceCookie(code: string): string {
  const parts = [
    `${SOURCE_COOKIE}=${code}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SOURCE_TTL_DAYS * 86400}`,
  ];
  if (env.publicBaseUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

export const goRouter = Router();

goRouter.get("/go/:code", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const code = String(req.params.code ?? "").toLowerCase();
  const ip = clientIp(req) ?? "unknown";
  if (!CODE_RE.test(code)) {
    res.redirect(302, "/");
    return;
  }
  let link = cached(code);
  if (link === undefined) {
    if (!lookupPerIp.hit(ip).ok) {
      res.redirect(302, "/");
      return;
    }
    const row = await prisma.siteLink.findUnique({ where: { code } }).catch((err) => {
      logError("links:go", err);
      return undefined;
    });
    // Сбой базы не кэшируем — только честное «такого кода нет».
    if (row === undefined) {
      res.redirect(302, "/");
      return;
    }
    link = row ? { id: row.id, code: row.code, path: redirectPath(row) } : null;
    remember(code, link);
  }
  if (!link) {
    res.redirect(302, "/");
    return;
  }
  // HEAD и предпросмотры не люди: не считаем и куку не ставим.
  if (req.method === "GET" && !isPreviewAgent(req.header("user-agent"))) {
    res.append("Set-Cookie", sourceCookie(link.code));
    const repeat = readCookie(req, CLICK_COOKIE) === link.code;
    if (!repeat) {
      res.append("Set-Cookie", clickCookie(link.code));
      if (writesPerIp.hit(ip).ok && writesTotal.hit("all").ok) {
        await prisma.siteLink
          .update({ where: { id: link.id }, data: { clicks: { increment: 1 }, lastClickAt: new Date() } })
          .catch((err) => logError("links:goCount", err));
      }
    }
  }
  res.redirect(302, link.path);
});

// ---------- источник заявки ----------

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** id ссылки, по которой пришёл этот посетитель; null — пришёл не по ней. */
export async function siteLinkIdFromRequest(req: Request): Promise<string | null> {
  const code = readCookie(req, SOURCE_COOKIE)?.toLowerCase();
  if (!code || !CODE_RE.test(code)) return null;
  const link = await prisma.siteLink.findUnique({ where: { code }, select: { id: true } }).catch((err) => {
    logError("links:source", err);
    return null;
  });
  return link?.id ?? null;
}

/**
 * Запомнить на контакте, с какой ссылки он пришёл. Только ПЕРВЫЙ раз: поздний
 * клик по другой рекламе не переписывает уже записанный источник. Ничего не
 * спрашиваем у человека и не собираем сверх того, что он и так оставил.
 */
export async function rememberContactSource(
  contact: { id: string; siteLinkId?: string | null },
  req: Request,
): Promise<void> {
  if (contact.siteLinkId) return;
  const siteLinkId = await siteLinkIdFromRequest(req);
  if (!siteLinkId) return;
  await prisma.contact
    .updateMany({ where: { id: contact.id, siteLinkId: null }, data: { siteLinkId } })
    .catch((err) => logError("links:rememberSource", err));
}
