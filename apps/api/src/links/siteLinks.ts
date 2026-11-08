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
 * источника заявки живут только здесь (сторож — tests/unit/linksArchitecture).
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

/** Список ссылок с переходами, обращениями и покупками по каждой. */
export async function listSiteLinks(take = 200) {
  const links = await prisma.siteLink.findMany({ orderBy: { createdAt: "desc" }, take });
  const ids = links.map((l) => l.id);
  const count = (rows: { siteLinkId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.siteLinkId, r._count._all]));
  const [contacts, buyers, freeLeads] = ids.length
    ? await Promise.all([
        prisma.contact.groupBy({ by: ["siteLinkId"], where: { siteLinkId: { in: ids } }, _count: { _all: true } }),
        prisma.contact.groupBy({
          by: ["siteLinkId"],
          where: { siteLinkId: { in: ids }, purchases: { some: { revokedAt: null } } },
          _count: { _all: true },
        }),
        prisma.freeLessonLead.groupBy({
          by: ["siteLinkId"],
          where: { siteLinkId: { in: ids } },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];
  const byContact = count(contacts);
  const byBuyer = count(buyers);
  const byFree = count(freeLeads);
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
    leads: (byContact.get(l.id) ?? 0) + (byFree.get(l.id) ?? 0),
    buyers: byBuyer.get(l.id) ?? 0,
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
 */
const PREVIEW_AGENT =
  /(facebookexternalhit|facebot|whatsapp\/|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|vkshare|pinterest|embedly|redditbot|applebot|googlebot|bingbot|yandex|baiduspider|duckduckbot|petalbot|ahrefsbot|semrushbot|mj12bot|bytespider|crawler|spider|[a-z]bot\/|curl\/|wget\/|python-requests|go-http-client|headlesschrome)/i;

export function isPreviewAgent(userAgent: string | undefined): boolean {
  return !userAgent || PREVIEW_AGENT.test(userAgent);
}

// Один адрес — не больше 60 переходов в минуту: дальше без похода в базу
// сразу на главную (человек не застрянет, а база не почувствует перебор).
const floodPerIp = createRateLimiter({ limit: 60, windowMs: 60_000 });
// Повторное нажатие той же ссылки с того же адреса в течение получаса — тот же
// человек, второй переход не считаем.
const clickPerIpLink = createRateLimiter({ limit: 1, windowMs: 30 * 60_000 });

/** Только для тестов. */
export function resetGoLimits(): void {
  floodPerIp.reset();
  clickPerIpLink.reset();
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
  if (!CODE_RE.test(code) || !floodPerIp.hit(ip).ok) {
    res.redirect(302, "/");
    return;
  }
  const link = await prisma.siteLink.findUnique({ where: { code } }).catch((err) => {
    logError("links:go", err);
    return null;
  });
  if (!link) {
    res.redirect(302, "/");
    return;
  }
  // HEAD и предпросмотры не люди: не считаем и куку не ставим.
  if (req.method === "GET" && !isPreviewAgent(req.header("user-agent"))) {
    res.append("Set-Cookie", sourceCookie(link.code));
    if (clickPerIpLink.hit(`${ip}:${link.code}`).ok) {
      await prisma.siteLink
        .update({ where: { id: link.id }, data: { clicks: { increment: 1 }, lastClickAt: new Date() } })
        .catch((err) => logError("links:goCount", err));
    }
  }
  res.redirect(302, redirectPath(link));
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
