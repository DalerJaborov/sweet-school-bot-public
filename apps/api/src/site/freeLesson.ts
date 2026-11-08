import { Router, type Request, type Response, type NextFunction } from "express";
import { autoCatch } from "../asyncRoute.js";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma, getSetting } from "../db.js";
import { env } from "../env.js";
import { masterManifest, variantManifest } from "../course/manifest.js";
import { getObject, presignGet, storageConfig } from "../storage/s3.js";
import { createRateLimiter } from "../services/rateLimit.js";
import { parseRecipeCard } from "../course/cardOcr.js";
import { parseStringArray } from "../json.js";
import { clientIp } from "../course/access.js";
import { siteLinkIdFromRequest } from "../links/siteLinks.js";

export const FREE_BASE = "/api/v1/free-lesson";
const COOKIE = "ssb_free_lesson";
const limiter = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
export const freeLessonRouter = autoCatch(Router());

/** One gate for discovery, registration, recipe, manifest, variants and key.
 * Missing settings mean OFF. No paid purchase or course session is created. */
export async function availableFreeLesson() {
  const [enabled, id] = await Promise.all([getSetting("freeLessonEnabled"), getSetting("freeLessonId")]);
  if (enabled !== "true" || !id) return null;
  return prisma.lesson.findFirst({
    where: { id, deletedAt: null, status: "READY", hlsPath: { not: null }, module: { course: { active: true } } },
  });
}

export function validFreeGrant(token: string | undefined, lessonId: string): boolean {
  if (!token) return false;
  try {
    const value = jwt.verify(token, env.jwtSecret, {
      algorithms: ["HS256"],
      audience: "free-lesson",
    }) as jwt.JwtPayload;
    return value.kind === "free-lesson" && value.lessonId === lessonId && typeof value.sub === "string";
  } catch {
    return false;
  }
}

function grantCookie(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}

freeLessonRouter.use(FREE_BASE, (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
freeLessonRouter.get(FREE_BASE, async (req, res) => {
  const lesson = await availableFreeLesson();
  if (!lesson) {
    res.json({ enabled: false });
    return;
  }
  const cfg = await storageConfig();
  const cover = lesson.coverPath ?? lesson.posterPath;
  res.json({
    enabled: true,
    unlocked: validFreeGrant(grantCookie(req), lesson.id),
    id: lesson.id,
    title: lesson.title,
    durationSec: lesson.durationSec,
    coverUrl: cfg && cover ? presignGet(cfg, cover, 300) : null,
  });
});

const signup = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(30),
  lang: z.enum(["ru", "tg"]),
});
freeLessonRouter.post(`${FREE_BASE}/signup`, async (req, res) => {
  const rate = limiter.hit(clientIp(req) ?? "unknown");
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate_limit" });
    return;
  }
  const parsed = signup.safeParse(req.body);
  const phone = parsed.success ? parsed.data.phone.replace(/[\s()+-]/g, "") : "";
  if (!parsed.success || !/^\d{9,15}$/.test(phone)) {
    res.status(400).json({ error: "invalid_fields" });
    return;
  }
  const lesson = await availableFreeLesson();
  if (!lesson) {
    res.status(404).json({ error: "unavailable" });
    return;
  }
  if (validFreeGrant(grantCookie(req), lesson.id)) {
    res.json({ ok: true });
    return;
  }
  // С какой рекламной ссылки пришла заявка (links/siteLinks.ts); без неё поле не пишем.
  const siteLinkId = await siteLinkIdFromRequest(req);
  const lead = await prisma.freeLessonLead.create({
    data: { name: parsed.data.name, phone, lang: parsed.data.lang, lessonId: lesson.id, ...(siteLinkId ? { siteLinkId } : {}) },
  });
  const token = jwt.sign({ kind: "free-lesson", lessonId: lesson.id }, env.jwtSecret, {
    algorithm: "HS256",
    audience: "free-lesson",
    subject: lead.id,
    expiresIn: "7d",
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.publicBaseUrl.startsWith("https://"),
    path: FREE_BASE,
    maxAge: 7 * 86400_000,
  });
  res.json({ ok: true });
});

async function guard(req: Request, res: Response, next: NextFunction) {
  const lesson = await availableFreeLesson();
  const token = grantCookie(req);
  if (!lesson || (req.params.id && req.params.id !== lesson.id) || !validFreeGrant(token, lesson.id)) {
    res.status(403).json({ error: "unavailable" });
    return;
  }
  res.locals.freeLesson = lesson;
  next();
}
freeLessonRouter.get(`${FREE_BASE}/content`, guard, (_req, res) => {
  const lesson = res.locals.freeLesson;
  res.json({
    id: lesson.id,
    title: lesson.title,
    recipeText: lesson.recipeText,
    recipePhotos: parseStringArray(lesson.recipePhotos).map((_, i) => `${FREE_BASE}/lessons/${lesson.id}/photo/${i}`),
    recipeData: lesson.recipeData ? parseRecipeCard(lesson.recipeData) : null,
    manifestUrl: `${FREE_BASE}/lessons/${lesson.id}/manifest`,
  });
});
freeLessonRouter.get(`${FREE_BASE}/lessons/:id/photo/:index`, guard, async (req, res) => {
  if (!/^\d+$/.test(req.params.index)) { res.sendStatus(404); return; }
  const key = parseStringArray(res.locals.freeLesson.recipePhotos)[Number(req.params.index)];
  const cfg = key ? await storageConfig() : null;
  const data = cfg && key ? await getObject(cfg, key) : null;
  if (!data) { res.sendStatus(404); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg").send(data);
});
freeLessonRouter.get(`${FREE_BASE}/lessons/:id/manifest`, guard, async (_req, res) => {
  const body = await masterManifest(res.locals.freeLesson, FREE_BASE);
  if (!body) {
    res.status(409).json({ error: "video_unavailable" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});
freeLessonRouter.get(`${FREE_BASE}/lessons/:id/variant/:name`, guard, async (req, res) => {
  const body = await variantManifest(res.locals.freeLesson, req.params.name, FREE_BASE);
  if (!body) {
    res.status(404).json({ error: "video_unavailable" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});
freeLessonRouter.get(`${FREE_BASE}/lessons/:id/key`, guard, (_req, res) => {
  const key = res.locals.freeLesson.encryptionKey;
  if (!key) {
    res.status(404).end();
    return;
  }
  res.type("application/octet-stream").send(Buffer.from(key, "base64"));
});

/**
 * ЗАКРЫТАЯ ВИТРИНА под бесплатным уроком: остальные уроки того же курса — только то, что можно
 * показать, не продав курс: порядок, название, обложка и ингредиенты БЕЗ количеств. Видео, ключ,
 * манифест, граммы, текст рецепта и фото рецептов отсюда физически не уходят (в select их нет).
 * Доступ — только по cookie бесплатного урока: нет урока → 404 (ничего не раскрываем), нет cookie → 401.
 */
const NUMERIC_TAIL = /[\s,:–—-]*\d[\d\s.,/–-]*\s*(г|гр|грамм\p{L}*|кг|мл|л|шт|дона|қошуқ|gr?|ml|kg)?\.?\s*$/iu;
const AMOUNT_UNIT = /\d[\d.,/–-]*\s*(?:г|гр|грамм\p{L}*|кг|мл|л|шт|дона|қошуқ|gr?|ml|kg)(?![\p{L}\d])/giu;
export function ingredientNames(recipeData: string | null): string[] {
  const card = recipeData ? parseRecipeCard(recipeData) : null;
  if (!card) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of card.components) {
    for (const item of group.items) {
      const name = item.ingredient.replace(AMOUNT_UNIT, "").replace(NUMERIC_TAIL, "").replace(/\s{2,}/g, " ").trim();
      if (name.length < 2 || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

async function showcaseLessons(free: { id: string; moduleId: string }) {
  const mod = await prisma.module.findUnique({ where: { id: free.moduleId }, select: { courseId: true } });
  if (!mod) return [];
  return prisma.lesson.findMany({
    where: { id: { not: free.id }, deletedAt: null, status: "READY", hlsPath: { not: null }, module: { courseId: mod.courseId } },
    orderBy: [{ module: { order: "asc" } }, { order: "asc" }],
    select: { id: true, title: true, order: true, coverPath: true, posterPath: true, recipeData: true },
  });
}

async function showcaseGuard(req: Request, res: Response, next: NextFunction) {
  const lesson = await availableFreeLesson();
  if (!lesson) { res.status(404).json({ error: "unavailable" }); return; }
  if (!validFreeGrant(grantCookie(req), lesson.id)) { res.status(401).json({ error: "unauthorized" }); return; }
  res.locals.freeLesson = lesson;
  next();
}
freeLessonRouter.get(`${FREE_BASE}/more`, showcaseGuard, async (_req, res) => {
  const rows = await showcaseLessons(res.locals.freeLesson);
  res.json({
    lessons: rows.map((r, i) => ({
      id: r.id,
      title: r.title,
      order: i + 1,
      coverUrl: (r.coverPath ?? r.posterPath) ? `${FREE_BASE}/more/${r.id}/cover` : null,
      ingredients: ingredientNames(r.recipeData),
    })),
  });
});
freeLessonRouter.get(`${FREE_BASE}/more/:id/cover`, showcaseGuard, async (req, res) => {
  const row = (await showcaseLessons(res.locals.freeLesson)).find((r) => r.id === req.params.id);
  const key = row?.coverPath ?? row?.posterPath;
  const cfg = key ? await storageConfig() : null;
  const data = cfg && key ? await getObject(cfg, key) : null;
  if (!data) { res.sendStatus(404); return; }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(key!.endsWith(".png") ? "image/png" : key!.endsWith(".webp") ? "image/webp" : "image/jpeg").send(data);
});
