import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma, getSetting, logError } from "../db.js";
import { upsertContact } from "../funnel.js";
import { aiReply, rescueImage, type RescuedImage } from "../ai.js";
import { runAfterPrevious } from "../debounce.js";
import { activeCourses } from "../services/courseCatalog.js";
import { getPrices } from "../services/priceService.js";
import { getOfflineFacts } from "../services/salesTextsService.js";
import { offlineCourseCard } from "../ai/offlineCourse.js";
import { courseDateLabel, toIsoDay, upcomingOfflineStartDate } from "../ai/courseDate.js";
import { notifyOwnerDirect } from "../systemAlerts.js";
import { clientIp } from "../course/access.js";
import { createRateLimiter } from "../services/rateLimit.js";
import { visitorOf } from "./visitor.js";
import type { Attachment } from "../ai/media.js";
import type { Contact, Message } from "@prisma/client";

/**
 * ПУБЛИЧНОЕ API САЙТА shirinsweets.online — каталог, чат с ботом, заявка на
 * офлайн-курс. Контракт с фронтом: scratchpad/site-contract.md (03.09.2026).
 *
 * Токена нет ни у одного маршрута: человека узнаём по подписанной куке
 * посетителя (site/visitor.ts). Контакт такого человека — обычный Contact с
 * channel="WEB", igUserId=<id посетителя>: вся остальная машина (история,
 * чеки, выдача курсов, карточки владельцу) работает с ним как с любым другим,
 * только исходящие уходят не в Meta, а в базу (messaging/send.ts).
 */

export const siteRouter = Router();

const API_BASE = "/api/site";

const HISTORY_TAKE = 50;
const CATALOG_TTL_MS = 60_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Значения по умолчанию — чтобы сайт не пустовал, пока владелец не заполнил
 *  настройки. Это реальные контакты школы на 03.09.2026. */
const DEFAULTS = {
  phone: "+992905355355",
  whatsappDigits: "992905355355",
  telegram: "https://t.me/shirin_sweets_dushanbe",
  instagram: "https://www.instagram.com/shirin.sweets.dushanbe/",
  tiktok: "https://tiktok.com/@shirin.sweets.dushanbe",
};

// Лимиты из контракта. Ключ по посетителю — от одного человека, по IP — от
// скрипта, который куку не хранит и на каждый запрос получает нового посетителя.
const chatPerVisitor = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });
const chatPerIp = createRateLimiter({ limit: 200, windowMs: 60 * 60_000 });
const signupPerIp = createRateLimiter({ limit: 3, windowMs: 60 * 60_000 });

/** Сбросить кэш витрины — после правки цен/текстов в панели, чтобы сайт
 *  показал новое сразу, а не через минуту. */
export function resetCatalogCache(): void {
  catalogCache = null;
}

/** Только для тестов: сбросить лимиты и кэш каталога между кейсами. */
export function resetSiteRateLimits(): void {
  chatPerVisitor.reset();
  chatPerIp.reset();
  signupPerIp.reset();
  catalogCache = null;
}

/**
 * Контакты, для которых сейчас в фоне генерируется ответ ИИ. Чат-виджет
 * узнаёт об этом через /chat/poll (`typing: true`) и показывает «Ширин
 * печатает…», пока не увидит ответ. Живёт только в памяти процесса — как и
 * дебаунс (debounce.ts): при рестарте просто гаснет, ничего страшного, ответ
 * всё равно придёт следующим poll'ом.
 */
const typingContacts = new Set<string>();

type Visitor = { id: string; isNew: boolean };

// Кука ставится на ЛЮБОЕ обращение к /api/site/* (контракт), поэтому
// посетитель определяется один раз здесь, а не в каждом обработчике.
siteRouter.use(API_BASE, (req: Request, res: Response, next: NextFunction) => {
  res.locals.visitor = visitorOf(req, res);
  next();
});

function visitor(res: Response): Visitor {
  return res.locals.visitor as Visitor;
}

function tooMany(res: Response, verdict: { retryAfterSec: number }): void {
  res.setHeader("Retry-After", String(verdict.retryAfterSec));
  res.status(429).json({ error: "Слишком много запросов, попробуйте чуть позже", retryAfterSec: verdict.retryAfterSec });
}

// ---------- каталог ----------

type Catalog = {
  courses: {
    code: string;
    title: string;
    description: string | null;
    price: number;
    currency: "TJS";
    coverUrl: string | null;
    lessonsCount: number;
    durationMin: number;
  }[];
  bundle: { price: number; fullPrice: number } | null;
  offline: { price: number; currency: "TJS"; nextStartDate: string | null; info: { ru: string; tg: string } };
  contacts: { phone: string; whatsapp: string; telegram: string; instagram: string; tiktok: string };
};

let catalogCache: { at: number; data: Catalog } | null = null;

async function buildCatalog(): Promise<Catalog> {
  const courses = await activeCourses();
  // Счётчики уроков — отдельным запросом по всем курсам сразу, а не по одному
  // на курс: витрину открывают чаще, чем что-либо ещё на сайте.
  const lessons = courses.length
    ? await prisma.lesson.findMany({
        where: { deletedAt: null, module: { courseId: { in: courses.map((c) => c.id) } } },
        select: { durationSec: true, module: { select: { courseId: true } } },
      })
    : [];
  const perCourse = new Map<string, { count: number; sec: number }>();
  for (const l of lessons) {
    const acc = perCourse.get(l.module.courseId) ?? { count: 0, sec: 0 };
    acc.count += 1;
    acc.sec += l.durationSec ?? 0;
    perCourse.set(l.module.courseId, acc);
  }

  // Дата набора — только будущая (ai/courseDate.upcomingOfflineStartDate):
  // прошедшую сайт не показывает, а пишет «дата уточняется».
  const [phone, waPhone, telegram, instagram, tiktok, offline, prices, startDate, infoRu, infoTg] = await Promise.all([
    getSetting("sitePhone"),
    getSetting("schoolWhatsappPhone"),
    getSetting("schoolTelegramGroupUrl"),
    getSetting("schoolInstagramUrl"),
    getSetting("siteTiktokUrl"),
    // Цена и факты офлайн-курса, цена комплекта — из раздела «Тексты и цены»,
    // те же, что читает бот: сайт не должен спорить с ботом.
    getOfflineFacts(),
    getPrices(),
    upcomingOfflineStartDate(),
    offlineCourseCard("ru"),
    offlineCourseCard("tg"),
  ]);
  const waDigits = waPhone?.replace(/\D/g, "") ?? "";

  // На витрину — только курсы, в которых реально есть уроки. Иначе покупательница
  // видит «Купить» и «сертификат» у пустого курса (COURSE50 «Арт-десерты» ждёт
  // импорта контента) и платит за то, чего физически нет. Найдено ревизией
  // 04.09.2026: комплект тоже показывался с этим курсом внутри.
  const ready = courses
    .map((c) => ({ course: c, stat: perCourse.get(c.id) ?? { count: 0, sec: 0 } }))
    .filter(({ stat }) => stat.count > 0);

  return {
    courses: ready.map(({ course: c, stat }) => ({
      code: c.code,
      title: c.title,
      description: c.description ?? null,
      price: c.price,
      currency: "TJS",
      coverUrl: c.coverUrl ?? null,
      lessonsCount: stat.count,
      durationMin: Math.round(stat.sec / 60),
    })),
    // Комплект «оба курса» имеет смысл только когда оба реально готовы.
    bundle: ready.length >= 2 ? { price: prices.bundle, fullPrice: prices.bundleFull } : null,
    offline: {
      price: offline.price,
      currency: "TJS",
      nextStartDate: startDate ? toIsoDay(startDate) : null,
      info: { ru: infoRu, tg: infoTg },
    },
    contacts: {
      phone: phone?.trim() || DEFAULTS.phone,
      whatsapp: `https://api.whatsapp.com/send?phone=${waDigits.length >= 9 ? waDigits : DEFAULTS.whatsappDigits}`,
      telegram: telegram?.trim() || DEFAULTS.telegram,
      instagram: instagram?.trim() || DEFAULTS.instagram,
      tiktok: tiktok?.trim() || DEFAULTS.tiktok,
    },
  };
}

siteRouter.get(`${API_BASE}/courses`, async (_req: Request, res: Response) => {
  if (!catalogCache || Date.now() - catalogCache.at > CATALOG_TTL_MS) {
    catalogCache = { at: Date.now(), data: await buildCatalog() };
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(catalogCache.data);
});

// ---------- чат ----------

const LANG = z.enum(["ru", "tg"]);

type Msg = { id: string; from: "client" | "bot" | "owner"; text: string | null; imageUrl: string | null; at: string };

function toMsg(m: Pick<Message, "id" | "direction" | "byHuman" | "text" | "imageUrl" | "createdAt">): Msg {
  return {
    id: m.id,
    from: m.direction === "IN" ? "client" : m.byHuman ? "owner" : "bot",
    text: m.text,
    imageUrl: m.imageUrl,
    at: m.createdAt.toISOString(),
  };
}

const MSG_SELECT = { id: true, direction: true, byHuman: true, text: true, imageUrl: true, createdAt: true } as const;

/** Контакт посетителя. Ник «site-<6 знаков>» — чтобы в панели и карточках
 *  владельцу было видно, что человек с сайта, и чем один отличается от другого. */
async function siteContact(v: Visitor): Promise<Contact> {
  return upsertContact(v.id, `site-${v.id.slice(0, 6)}`, "WEB");
}

async function findSiteContact(v: Visitor): Promise<Contact | null> {
  if (v.isNew) return null;
  return prisma.contact.findUnique({ where: { channel_igUserId: { channel: "WEB", igUserId: v.id } } });
}

/** Всё, что появилось ПОСЛЕ сообщения `afterId` (по времени, не по id — id
 *  случайные). Неизвестный id — как «с начала», но не больше HISTORY_TAKE. */
async function messagesAfter(contactId: string, afterId: string | null): Promise<Msg[]> {
  const anchor = afterId
    ? await prisma.message.findFirst({ where: { id: afterId, contactId }, select: { createdAt: true } })
    : null;
  const rows = await prisma.message.findMany({
    where: { contactId, ...(anchor ? { createdAt: { gt: anchor.createdAt } } : {}) },
    orderBy: { createdAt: "asc" },
    ...(anchor ? {} : { take: HISTORY_TAKE }),
    select: MSG_SELECT,
  });
  return rows.map(toMsg);
}

async function history(contactId: string): Promise<Msg[]> {
  const rows = await prisma.message.findMany({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TAKE,
    select: MSG_SELECT,
  });
  return rows.reverse().map(toMsg);
}

siteRouter.post(`${API_BASE}/chat/start`, async (req: Request, res: Response) => {
  const parsed = z.object({ lang: LANG.optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "lang должен быть ru или tg" });
    return;
  }
  const v = visitor(res);
  const contact = await siteContact(v);
  // Язык сайта — лучшая подсказка о языке человека до первого сообщения:
  // модель и карточки (offlineCourse.ts) смотрят на preferredLanguage.
  if (parsed.data.lang && contact.preferredLanguage !== parsed.data.lang) {
    await prisma.contact
      .update({ where: { id: contact.id }, data: { preferredLanguage: parsed.data.lang } })
      .catch((err) => logError("site:start:lang", err));
  }
  res.json({ visitorId: v.id, messages: v.isNew ? [] : await history(contact.id) });
});

/**
 * Файл чека из формы. В памяти, не на диске: дальше он всё равно сохраняется
 * копией через rescueImage (тот же путь, что у Instagram), а второй файл на
 * диске никому не нужен. Ошибки multer (размер, тип) превращаем в понятный
 * JSON, иначе Express отдал бы HTML-страницу с трассировкой.
 */
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
  },
}).single("image");

function parseImage(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  receiptUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? "Файл больше 10 МБ — пришлите скриншот поменьше" : "Нужна картинка: jpeg, png, webp или heic",
      });
      return;
    }
    next(err);
  });
}

siteRouter.post(`${API_BASE}/chat/send`, parseImage, async (req: Request, res: Response) => {
  const v = visitor(res);
  const ip = clientIp(req) ?? "unknown";
  const byVisitor = chatPerVisitor.hit(v.id);
  if (!byVisitor.ok) return tooMany(res, byVisitor);
  const byIp = chatPerIp.hit(ip);
  if (!byIp.ok) return tooMany(res, byIp);

  const parsed = z
    .object({ text: z.string().trim().min(1).max(2000).optional() })
    .safeParse(req.body ?? {});
  const file = req.file;
  if (!parsed.success || (!parsed.data.text && !file)) {
    res.status(400).json({ error: "Нужен текст (1–2000 знаков) или картинка" });
    return;
  }
  const text = parsed.data.text ?? "";

  const contact = await siteContact(v);

  // Картинка = чек: тот же конвейер, что у Instagram (rescue → очередь → разбор
  // в aiReply). Сохраняется ДО записи сообщения, чтобы в ленте сайта чек был
  // виден по нашей публичной ссылке.
  let rescued: RescuedImage[] = [];
  let attachments: Attachment[] = [];
  if (file) {
    const one = await rescueImage(contact, file.buffer, file.mimetype).catch((err) => {
      logError("site:send:rescue", err);
      return null;
    });
    if (!one?.url) {
      res.status(500).json({ error: "Не удалось сохранить картинку, попробуйте ещё раз" });
      return;
    }
    rescued = [one];
    attachments = [{ url: one.url, kind: "image" }];
  }

  const echo = await prisma.message.create({
    data: { contactId: contact.id, direction: "IN", text: text || null, imageUrl: rescued[0]?.url ?? null },
    select: MSG_SELECT,
  });

  // Отвечаем МГНОВЕННО своим же эхом — человек не ждёт, пока ИИ подумает.
  // Сама генерация ответа идёт в фоне, но СТРОГО по очереди с прошлым ходом
  // этого же контакта — иначе два быстрых сообщения получили бы два
  // независимых ответа на одно и то же (см. debounce.ts).
  typingContacts.add(contact.id);
  runAfterPrevious(contact.id, async () => {
    try {
      const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
      if (fresh) await aiReply(fresh, text, attachments, rescued);
    } catch (err) {
      logError("site:aiReply", err);
    } finally {
      typingContacts.delete(contact.id);
    }
  });

  res.json({ messages: [toMsg(echo)], pending: true });
});

siteRouter.get(`${API_BASE}/chat/poll`, async (req: Request, res: Response) => {
  const after = typeof req.query.after === "string" && req.query.after ? req.query.after : null;
  const contact = await findSiteContact(visitor(res));
  if (!contact) {
    res.json({ messages: [] });
    return;
  }
  const messages = await messagesAfter(contact.id, after);
  res.json({ messages, ...(typingContacts.has(contact.id) ? { typing: true } : {}) });
});

// ---------- заявка на офлайн-курс ----------

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z
    .string()
    .trim()
    .min(9)
    .max(20)
    .regex(/^[\d+ ]+$/, "цифры, плюс и пробелы"),
  lang: LANG.optional(),
});

siteRouter.post(`${API_BASE}/offline-signup`, async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Нужны имя (2–80 знаков) и телефон (9–20 знаков: цифры, + и пробелы)" });
    return;
  }
  const ip = clientIp(req) ?? "unknown";
  const limit = signupPerIp.hit(ip);
  if (!limit.ok) return tooMany(res, limit);

  const { name, phone, lang } = parsed.data;
  const contact = await siteContact(visitor(res));
  if (lang && contact.preferredLanguage !== lang) {
    await prisma.contact
      .update({ where: { id: contact.id }, data: { preferredLanguage: lang } })
      .catch((err) => logError("site:signup:lang", err));
  }

  // Заявка — входящее сообщение: так она видна в переписке в панели, и бот,
  // если человек потом напишет в чат, знает, что запись уже есть.
  await prisma.message.create({
    data: { contactId: contact.id, direction: "IN", text: `Заявка на офлайн-курс: ${name}, ${phone}` },
  });

  // Та же таблица, что у заявок из Instagram (ai/offlineSignup.ts): по ней
  // offlineReminder.ts напоминает за сутки до старта. Повторная заявка того же
  // посетителя запись не дублирует, но владельцу уходит снова — человек мог
  // исправить номер.
  const existing = await prisma.offlineSignup.findUnique({ where: { contactId: contact.id } });
  if (!existing) {
    await prisma.offlineSignup
      .create({ data: { contactId: contact.id, name, phone, notified: true } })
      .catch((err) => logError("site:signup:create", err));
  }

  const date = await courseDateLabel(lang ?? "ru");
  await notifyOwnerDirect(
    `📝 Заявка с САЙТА на офлайн-курс (${date})\n\n` +
      `👤 ${name}\n` +
      `📲 ${phone}\n` +
      `🌐 ${contact.username ?? "сайт"}${lang ? `, язык: ${lang}` : ""}\n` +
      `\nПросит записать. Предоплаты нет — позвонить за день до курса.`
  ).catch((err) => logError("site:signup:notify", err));

  res.json({ ok: true });
});
