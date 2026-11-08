import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../db.js";
import { autoCatch } from "../asyncRoute.js";
import { courseTokenSecret } from "./tokenSecret.js";
import { masterManifest, variantManifest } from "./manifest.js";
import { buildCourseViews, COURSE_TREE_INCLUDE } from "./view.js";
import { isCourseLanguage, type CourseLanguage } from "./i18n.js";

/**
 * «ПОСМОТРЕТЬ КАК УЧЕНИЦА» — предпросмотр курса для владельца (08.11.2026).
 *
 * Ширин хочет видеть уроки ровно так, как их видит ученица: список, плеер,
 * рецепты. Раньше для этого оставалось одно — «купить» курс самой себе, то
 * есть завести покупку, устройство и прогресс в боевой базе. Такая покупка
 * попадала в выручку, в «не открыла уроки», в напоминания и в статистику.
 *
 * ПОЭТОМУ ЭТО ОТДЕЛЬНАЯ ДВЕРЬ, А НЕ ПОДДЕЛАННАЯ УЧЕНИЦА:
 *  • ТОЛЬКО ЧТЕНИЕ. Здесь нет ни одной записи в базу — ни покупки, ни
 *    устройства, ни прогресса, ни вопроса в чат. Это держит сторож в тестах
 *    (tests/unit/coursePreview.test.ts читает этот файл и падает на любом
 *    create/update/upsert/delete). Единственное, что может появиться в базе, —
 *    перевод названий в общем кеше переводов (i18n.ts): это не данные людей и
 *    не статистика, а тот же текст, который ученица получила бы сама.
 *  • ВХОД ТОЛЬКО ИЗ ПАНЕЛИ. Билет выпускает /admin/course-preview — за той же
 *    проверкой пароля, что и вся панель. Билет живёт 10 минут и годится ОДИН
 *    раз: адрес с ним может остаться в истории браузера, второй раз он не
 *    откроет ничего.
 *  • СВОЯ КУКА НА СВОЁМ ПУТИ. Сессия предпросмотра — кука ssb_preview с
 *    Path=/api/course/preview: она не видна обычным адресам ученицы и не может
 *    подменить её сессию, а сессия ученицы не открывает предпросмотр.
 *  • СВОЙ СЕКРЕТ. Подпись выводится из секрета учениц с другой меткой, поэтому
 *    токен предпросмотра физически не проходит как ссылка, сессия или
 *    pair-токен ученицы, и наоборот (тот же приём, что в tokenSecret.ts).
 *  • ТОЛЬКО СОДЕРЖИМОЕ КУРСА. Ни имён, ни контактов, ни прогресса учениц —
 *    отдаётся то же, что видит новая ученица до первого урока.
 *  • КОРОТКО. Сессия живёт два часа; дальше — снова кнопка в панели.
 */

const START_TTL_SEC = 10 * 60;
const SESSION_TTL_SEC = 2 * 3600;
const COOKIE = "ssb_preview";
export const PREVIEW_API = "/api/course/preview";

type StartClaims = { kind: "course-preview-start"; courseIds: string[]; jti: string };
type SessionClaims = { kind: "course-preview-session"; courseIds: string[] };

/** Метка назначения. Сменишь — погаснут только живые предпросмотры, ученицы
 *  не заметят ничего: их токены подписаны другим ключом. */
const PURPOSE = "sweet-school-course-preview-v1";

function previewSecret(): string {
  return crypto.createHmac("sha256", courseTokenSecret()).update(PURPOSE).digest("hex");
}

/**
 * Использованные билеты. В памяти процесса: сервер один, билет живёт десять
 * минут, а перезапуск посреди этих десяти минут обойдётся владельцу одним
 * лишним нажатием кнопки, а не дырой.
 */
const usedTickets = new Map<string, number>();

function rememberTicket(jti: string, expiresAtMs: number): boolean {
  const now = Date.now();
  for (const [id, until] of usedTickets) if (until < now) usedTickets.delete(id);
  if (usedTickets.has(jti)) return false;
  usedTickets.set(jti, expiresAtMs);
  return true;
}

/** Только для тестов. */
export function resetPreviewTickets(): void {
  usedTickets.clear();
}

/** Билет на предпросмотр. Вызывается ТОЛЬКО из панели (adminRoutes.ts). */
export function issuePreviewTicket(courseIds: string[]): string {
  return jwt.sign(
    { kind: "course-preview-start", courseIds, jti: crypto.randomUUID() } satisfies StartClaims,
    previewSecret(),
    { expiresIn: START_TTL_SEC },
  );
}

function verify<T extends { kind: string }>(token: string, kind: T["kind"]): (T & { exp?: number }) | null {
  try {
    const claims = jwt.verify(token, previewSecret()) as T & { exp?: number };
    return claims?.kind === kind ? claims : null;
  } catch {
    return null;
  }
}

function validIds(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 20 &&
    ids.every((id) => typeof id === "string" && id.length > 0)
  );
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function sessionCookie(value: string, maxAgeSec: number): string {
  const parts = [`${COOKIE}=${value}`, `Path=${PREVIEW_API}`, "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if ((env.publicBaseUrl || "").startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

/** Какие курсы разрешено смотреть этой сессии предпросмотра; null — сессии нет. */
export function previewCourseIds(req: Request): string[] | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const claims = verify<SessionClaims>(token, "course-preview-session");
  return claims && validIds(claims.courseIds) ? claims.courseIds : null;
}

function apiBase(): string {
  return `${(env.publicBaseUrl || "").replace(/\/+$/, "")}${PREVIEW_API}`;
}

function noSession(res: Response): void {
  res.status(401).json({
    error: "Предпросмотр закрыт — откройте его снова кнопкой «Посмотреть как ученица» в панели",
    reason: "preview_expired",
  });
}

/** Урок из разрешённых курсов (не из корзины) — иначе null. */
async function previewLesson(courseIds: string[], lessonId: string) {
  const lesson = await prisma.lesson.findFirst({ where: { id: lessonId, deletedAt: null }, include: { module: true } });
  if (!lesson || !courseIds.includes(lesson.module.courseId)) return null;
  return lesson;
}

export const coursePreviewRouter = autoCatch(Router());

/** Обмен билета из адреса на куку предпросмотра. Билет — одноразовый. */
coursePreviewRouter.post(`${PREVIEW_API}/start`, (req: Request, res: Response) => {
  const parsed = z.object({ ticket: z.string().min(20).max(2000) }).safeParse(req.body);
  const claims = parsed.success ? verify<StartClaims>(parsed.data.ticket, "course-preview-start") : null;
  if (!claims || !validIds(claims.courseIds) || !claims.jti || !claims.exp) {
    noSession(res);
    return;
  }
  if (!rememberTicket(claims.jti, claims.exp * 1000)) {
    res
      .status(401)
      .json({
        error: "Эта ссылка предпросмотра уже открыта — нажмите кнопку в панели ещё раз",
        reason: "preview_used",
      });
    return;
  }
  const session = jwt.sign(
    { kind: "course-preview-session", courseIds: claims.courseIds } satisfies SessionClaims,
    previewSecret(),
    { expiresIn: SESSION_TTL_SEC },
  );
  res.setHeader("Set-Cookie", sessionCookie(session, SESSION_TTL_SEC));
  res.json({ ok: true });
});

/** Выйти из предпросмотра — кука гаснет сразу. */
coursePreviewRouter.post(`${PREVIEW_API}/end`, (_req: Request, res: Response) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
});

/**
 * Экран «как у ученицы», которая только что купила курс: тот же набор полей,
 * что /api/course/me, но без прогресса, сертификата и личных данных.
 */
coursePreviewRouter.get(`${PREVIEW_API}/me`, async (req: Request, res: Response) => {
  const courseIds = previewCourseIds(req);
  if (!courseIds) return noSession(res);
  const lang: CourseLanguage = isCourseLanguage(req.query.lang) ? req.query.lang : "tg";

  const courses = await prisma.course.findMany({
    where: { id: { in: courseIds } },
    orderBy: { order: "asc" },
    include: COURSE_TREE_INCLUDE,
  });
  const out = await buildCourseViews({
    courses,
    lang,
    progress: new Map(),
    certificates: new Map(),
    purchaseIdFor: () => null,
  });

  res.json({
    ready: out.length > 0,
    preview: true,
    message: out.length > 0 ? undefined : "Курс не найден",
    // Водяной знак — честная надпись вместо имени ученицы: запись экрана из
    // предпросмотра не должна выглядеть как чья-то утечка.
    watermark: "Предпросмотр",
    profile: { firstName: null, lastName: null, language: lang },
    school: null,
    offlineUntil: null,
    courses: out,
    course: out[0] ?? null,
  });
});

coursePreviewRouter.get(`${PREVIEW_API}/lessons/:id/manifest`, async (req: Request, res: Response) => {
  const courseIds = previewCourseIds(req);
  if (!courseIds) return noSession(res);
  const lesson = await previewLesson(courseIds, req.params.id);
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const body = await masterManifest(lesson, apiBase());
  if (!body) {
    res.status(409).json({ error: "Видео этого урока ещё готовится" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});

coursePreviewRouter.get(`${PREVIEW_API}/lessons/:id/variant/:name`, async (req: Request, res: Response) => {
  const courseIds = previewCourseIds(req);
  if (!courseIds) return noSession(res);
  const lesson = await previewLesson(courseIds, req.params.id);
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const body = await variantManifest(lesson, req.params.name, apiBase());
  if (!body) {
    res.status(404).json({ error: "Качество недоступно" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});

/** Ключ расшифровки — только для уроков разрешённых курсов и только живой
 *  сессии предпросмотра. Офлайн-срока здесь нет: предпросмотр не сохраняет
 *  уроки в телефон. */
coursePreviewRouter.get(`${PREVIEW_API}/lessons/:id/key`, async (req: Request, res: Response) => {
  const courseIds = previewCourseIds(req);
  if (!courseIds) return noSession(res);
  const lesson = await previewLesson(courseIds, req.params.id);
  if (!lesson?.encryptionKey) {
    res.status(404).json({ error: "Ключ недоступен" });
    return;
  }
  res.type("application/octet-stream").setHeader("Cache-Control", "private, no-store");
  res.send(Buffer.from(lesson.encryptionKey, "base64"));
});
