import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../env.js";
import { prisma, logError, getSetting } from "../db.js";
import { autoCatch } from "../asyncRoute.js";
import { parseStringArray, parseCourseTools } from "../json.js";
import {
  storageConfig,
  putObject,
  putObjectStream,
  deleteObject,
  presignGet,
  checkStorageReachable,
  listBuckets,
} from "../storage/s3.js";
import { processLesson, ffmpegAvailable } from "../storage/videoPipeline.js";
import { createBackgroundJob, type StartResult } from "../services/importService.js";
import { backfillCourses, logBackfill } from "../services/courseCatalog.js";
import { unansweredCount, answerFromPanel, draftFromPanel, type PanelDraft } from "./chat.js";
import { recipeCardToMarkdown, type RecipeCard } from "./cardOcr.js";
import { parsePastedCredentials, missingParts, summarize } from "../storage/pasteCredentials.js";
import { writeSettings } from "../services/settingsService.js";
import { resetTodayCache } from "../today.js";
import { softDeleteLesson, restoreLesson, listTrash, vacateTrashedOrder } from "./lessonTrash.js";

/**
 * АДМИНКА ПЛАТФОРМЫ — курсы, уроки, видео, рецепты, устройства и вопросы.
 *
 * Монтируется в adminRouter, поэтому проверка пароля уже стоит выше и здесь
 * не повторяется.
 *
 * Видео принимается на диск сервера и уходит в хранилище ФОНОМ: получасовой
 * ролик это сотни мегабайт и минуты работы, столько HTTP-запрос не живёт, а
 * Cloudflare оборвёт его на сотой секунде.
 */

// autoCatch свой: обёртка adminRouter на вложенные роутеры не распространяется (см. today.ts).
export const courseAdminRouter = autoCatch(Router());

/** Уроки бывают на сотни мегабайт — общий лимит загрузок (25 МБ, под лимит
 *  Instagram) здесь неприменим, поэтому свой multer со своим потолком. */
const VIDEO_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
};
const PHOTO_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const TMP_DIR = "/data/uploads/course-tmp";

const videoUpload = multer({
  storage: multer.diskStorage({
    // Папку создаём при первой загрузке, а не при импорте модуля: так роутер
    // можно поднять в тестах и на машине без /data, а на проде она появляется
    // ровно тогда, когда нужна.
    destination: (_req, _file, cb) => fs.mkdir(TMP_DIR, { recursive: true }, (err) => cb(err, TMP_DIR)),
    // Расширение берём из mimetype, а не из имени файла: имя приходит от
    // клиента и подделывается независимо от типа (та же ловушка разобрана в
    // upload.ts).
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${VIDEO_MIME[file.mimetype] ?? ".bin"}`),
  }),
  limits: { fileSize: VIDEO_LIMIT_BYTES },
});

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ---------- каталог ----------

courseAdminRouter.get("/admin/courses", async (_req, res) => {
  const courses = await prisma.course.findMany({
    orderBy: { order: "asc" },
    include: {
      modules: {
        orderBy: { order: "asc" },
        // Корзина («Утро Ширин» §19): удалённые уроки — отдельной ручкой
        // /admin/lessons/trash, в списке их нет.
        include: { lessons: { where: { deletedAt: null }, orderBy: { order: "asc" } } },
      },
      _count: { select: { purchases: true } },
    },
  });
  const cfg = await storageConfig();
  res.json({
    storageReady: Boolean(cfg),
    courses: courses.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      description: c.description,
      price: c.price,
      active: c.active,
      deviceLimit: c.deviceLimit,
      students: c._count.purchases,
      // Набор инструментов (§5 визуальной системы) — правится отдельной ручкой
      // ниже (PUT /admin/courses/:id), а не через lessonSchema: это поле курса,
      // не урока.
      toolsData: parseCourseTools(c.toolsData),
      modules: c.modules.map((m) => ({
        id: m.id,
        title: m.title,
        order: m.order,
        lessons: m.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          order: l.order,
          status: l.status,
          durationSec: l.durationSec,
          hasVideo: Boolean(l.hlsPath),
          recipeText: l.recipeText,
          recipePhotos: cfg ? parseStringArray(l.recipePhotos).map((p) => presignGet(cfg, p, 6 * 3600)) : [],
          // Проверка OCR-рецептов («Утро Ширин» §13): бейдж «с карточки, не
          // проверено» — пока владелица не нажала «Проверила ✓».
          recipeSource: l.recipeSource,
          recipeReviewedAt: l.recipeReviewedAt,
          needsRecipeReview: needsRecipeReview(l),
          // Обложка 16:9 для списка уроков (§8) — та же, что видит ученица;
          // у старых уроков без рендера обложек — кадр постера.
          coverUrl: cfg ? presignCover(cfg, l.coverPath ?? l.posterPath) : null,
          isPreview: l.isPreview,
          transcript: l.transcript,
          transcriptStatus: l.transcriptStatus,
          // Аудиодорожка для ручной расшифровки в AI Studio: кладётся рядом с
          // HLS при перекодировке (videoPipeline.ts). У старых уроков её нет.
          audioUrl: cfg && l.hlsPath ? presignGet(cfg, l.hlsPath.replace(/master\.m3u8$/, "audio.mp3"), 6 * 3600) : null,
        })),
      })),
    })),
  });
});

function presignCover(cfg: NonNullable<Awaited<ReturnType<typeof storageConfig>>>, key: string | null): string | null {
  return key ? presignGet(cfg, key, 6 * 3600) : null;
}

/** Рецепт распознан с карточки и ещё не сверен владелицей. */
function needsRecipeReview(l: { recipeSource: string | null; recipeReviewedAt: Date | null }): boolean {
  return l.recipeSource === "card-ocr" && l.recipeReviewedAt === null;
}

/** Условие «не проверено» для базы — одно на счётчик и на список. */
const REVIEW_WHERE = { recipeSource: "card-ocr", recipeReviewedAt: null, deletedAt: null } as const;

const toolSchema = z.object({
  name: z.string().trim().min(1).max(120),
  photoUrl: z.string().url().nullable().optional(),
  toolNumber: z.string().trim().max(40).nullable().optional(),
  buyLink: z.string().url().nullable().optional(),
});

/** Набор инструментов курса (§5) — фото заливается тем же общим
 *  /admin/upload, что и у отзывов (см. admin.ts): здесь только сохраняем
 *  готовый список, ссылку на фото в нём владелец получает от того эндпоинта. */
courseAdminRouter.put("/admin/courses/:id", async (req, res) => {
  const parsed = z.object({ toolsData: z.array(toolSchema).max(50) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный список инструментов" });
    return;
  }
  try {
    const toolsData = parsed.data.toolsData.map((tool) => ({
      name: tool.name,
      photoUrl: tool.photoUrl ?? null,
      toolNumber: tool.toolNumber ?? null,
      buyLink: tool.buyLink ?? null,
    }));
    await prisma.course.update({ where: { id: req.params.id }, data: { toolsData: JSON.stringify(toolsData) } });
    res.json({ ok: true });
  } catch (err) {
    logError("courseAdmin:updateCourse", err);
    res.status(404).json({ error: "Курс не найден" });
  }
});

/** Первичное заполнение каталога из констант — та же операция, что скрипт
 *  backfill, но кнопкой: владельцу незачем ходить в консоль сервера. */
courseAdminRouter.post("/admin/courses/backfill", async (_req, res) => {
  const result = await backfillCourses();
  logBackfill(result);
  res.json(result);
});

const moduleSchema = z.object({ title: z.string().min(1).max(200), order: z.number().int().min(0).max(999) });

courseAdminRouter.post("/admin/courses/:id/modules", async (req, res) => {
  const parsed = moduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужны название и номер раздела" });
    return;
  }
  try {
    const created = await prisma.module.create({ data: { ...parsed.data, courseId: req.params.id } });
    res.json({ id: created.id });
  } catch (err) {
    // P2002 — раздел с таким номером в курсе уже есть: номера задают порядок
    // показа, дубль сделал бы его неопределённым.
    logError("courseAdmin:createModule", err);
    res.status(409).json({ error: "Раздел с таким номером уже есть" });
  }
});

const lessonSchema = z.object({
  title: z.string().min(1).max(200),
  order: z.number().int().min(0).max(999),
  recipeText: z.string().max(20000).nullable().optional(),
  isPreview: z.boolean().optional(),
  /** Расшифровка урока — владелец вставляет руками (решение 03.09.2026:
   *  бесплатно через Google AI Studio в браузере, без API-токенов). */
  transcript: z.string().max(200000).nullable().optional(),
});

courseAdminRouter.post("/admin/modules/:id/lessons", async (req, res) => {
  const parsed = lessonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужны название и номер урока" });
    return;
  }
  const data = {
    moduleId: req.params.id,
    title: parsed.data.title,
    order: parsed.data.order,
    recipeText: parsed.data.recipeText ?? null,
    isPreview: parsed.data.isPreview ?? false,
  };
  try {
    const created = await prisma.lesson.create({ data });
    res.json({ id: created.id });
  } catch (err) {
    // Номер занят уроком из корзины — это не конфликт, а тень удалённого:
    // освобождаем место и создаём ещё раз.
    if (await vacateTrashedOrder(req.params.id, parsed.data.order)) {
      const created = await prisma.lesson.create({ data });
      res.json({ id: created.id });
      return;
    }
    logError("courseAdmin:createLesson", err);
    res.status(409).json({ error: "Урок с таким номером в этом разделе уже есть" });
  }
});

courseAdminRouter.put("/admin/lessons/:id", async (req, res) => {
  const parsed = lessonSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверные данные урока" });
    return;
  }
  try {
    // Вставили расшифровку — помощник в чате может ей пользоваться сразу;
    // стёрли — честно помечаем, что расшифровки нет.
    const data =
      parsed.data.transcript !== undefined
        ? { ...parsed.data, transcriptStatus: parsed.data.transcript?.trim() ? "READY" : "SKIPPED" }
        : parsed.data;
    await prisma.lesson.update({ where: { id: req.params.id }, data });
    res.json({ ok: true });
  } catch (err) {
    logError("courseAdmin:updateLesson", err);
    res.status(404).json({ error: "Урок не найден" });
  }
});

/**
 * КОРЗИНА («Утро Ширин» §19): удаление мягкое — урок исчезает из списков и у
 * учениц, но 24 часа его можно вернуть; чистка — course/lessonTrash.ts.
 */
courseAdminRouter.delete("/admin/lessons/:id", async (req, res) => {
  const result = await softDeleteLesson(req.params.id);
  if (!result) {
    res.status(404).json({ error: "Урок уже удалён или не найден" });
    return;
  }
  res.json({ ok: true, undoUntil: result.undoUntil.toISOString() });
});

courseAdminRouter.post("/admin/lessons/:id/restore", async (req, res) => {
  const result = await restoreLesson(req.params.id);
  if (!result) {
    res.status(404).json({ error: "Урока нет в корзине" });
    return;
  }
  res.json({ ok: true, order: result.order });
});

courseAdminRouter.get("/admin/lessons/trash", async (_req, res) => {
  const rows = await listTrash();
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      module: r.module,
      course: r.course,
      deletedAt: r.deletedAt.toISOString(),
      purgeAt: r.purgeAt.toISOString(),
    })),
  });
});

// ---------- проверка OCR-рецептов ----------

/**
 * ПРОВЕРКА РЕЦЕПТОВ С КАРТОЧЕК («Утро Ширин» §13). Импорт читает карточку
 * через Gemini, и модель может прочитать «250» как «260» — никто, кроме
 * Ширин, этого не заметит. Экран показывает фото карточки рядом со
 * структурированным рецептом (Lesson.recipeData), даёт поправить строки и
 * «Проверила ✓» — тогда из структуры заново собирается markdown recipeText
 * (тем же recipeCardToMarkdown, что и при импорте: два поля не расходятся),
 * а recipeReviewedAt снимает бейдж и убирает урок из очереди на главной.
 */

const recipeItemSchema = z.object({
  ingredient: z.string().trim().min(1).max(200),
  amount: z.string().trim().max(40).nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  emoji: z.string().trim().max(8).nullable().optional(),
});
const recipeCardSchema = z.object({
  title: z.string().trim().max(200).optional(),
  language: z.string().trim().max(5).optional(),
  components: z
    .array(z.object({ name: z.string().trim().max(120).optional(), items: z.array(recipeItemSchema).max(100) }))
    .min(1)
    .max(30),
});

/** Строгая форма RecipeCard из тела запроса: пустые строки → null, без пустых компонентов. */
function normalizeRecipeCard(input: z.infer<typeof recipeCardSchema>, fallback: RecipeCard | null): RecipeCard | null {
  const components = input.components
    .map((c) => ({
      name: c.name ?? "",
      items: c.items.map((it) => ({
        ingredient: it.ingredient,
        amount: it.amount || null,
        unit: it.unit || null,
        note: it.note || null,
        emoji: it.emoji || null,
      })),
    }))
    .filter((c) => c.items.length > 0);
  if (!components.length) return null;
  return {
    title: input.title ?? fallback?.title ?? "",
    components,
    language: (input.language ?? fallback?.language ?? "tg").toLowerCase(),
  };
}

function parseRecipeData(raw: string | null): RecipeCard | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RecipeCard;
    return parsed && Array.isArray(parsed.components) ? parsed : null;
  } catch {
    return null;
  }
}

/** Сколько рецептов ждут проверки — счётчик для очереди на главной. */
courseAdminRouter.get("/admin/recipes/review-count", async (_req, res) => {
  res.json({ count: await prisma.lesson.count({ where: REVIEW_WHERE }) });
});

/** Список уроков на проверку — экран «Проверить рецепты». */
courseAdminRouter.get("/admin/recipes/review", async (_req, res) => {
  const lessons = await prisma.lesson.findMany({
    where: REVIEW_WHERE,
    orderBy: [{ module: { course: { order: "asc" } } }, { module: { order: "asc" } }, { order: "asc" }],
    include: { module: { select: { title: true, course: { select: { title: true } } } } },
  });
  const cfg = await storageConfig();
  res.json({
    rows: lessons.map((l) => ({
      id: l.id,
      title: l.title,
      order: l.order,
      module: l.module.title,
      course: l.module.course.title,
      coverUrl: cfg ? presignCover(cfg, l.coverPath ?? l.posterPath) : null,
      photos: parseStringArray(l.recipePhotos).length,
    })),
  });
});

courseAdminRouter.get("/admin/lessons/:id/recipe", async (req, res) => {
  const lesson = await prisma.lesson.findUnique({
    where: { id: req.params.id },
    include: { module: { select: { title: true, course: { select: { title: true } } } } },
  });
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const cfg = await storageConfig();
  res.json({
    id: lesson.id,
    title: lesson.title,
    order: lesson.order,
    module: lesson.module.title,
    course: lesson.module.course.title,
    recipeSource: lesson.recipeSource,
    recipeReviewedAt: lesson.recipeReviewedAt,
    needsReview: needsRecipeReview(lesson),
    recipeText: lesson.recipeText,
    recipeData: parseRecipeData(lesson.recipeData),
    // Ссылки живут 6 часов — как и в списке курсов: проверка одного рецепта
    // столько не длится, а вечные ссылки на закрытые фото не нужны.
    photos: cfg ? parseStringArray(lesson.recipePhotos).map((p) => presignGet(cfg, p, 6 * 3600)) : [],
  });
});

courseAdminRouter.put("/admin/lessons/:id/recipe", async (req, res) => {
  const parsed = z.object({ recipeData: recipeCardSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "В рецепте должен быть хотя бы один ингредиент" });
    return;
  }
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const card = normalizeRecipeCard(parsed.data.recipeData, parseRecipeData(lesson.recipeData));
  if (!card) {
    res.status(400).json({ error: "В рецепте должен быть хотя бы один ингредиент" });
    return;
  }
  const recipeText = recipeCardToMarkdown(card);
  const reviewedAt = new Date();
  await prisma.lesson.update({
    where: { id: lesson.id },
    data: { recipeData: JSON.stringify(card), recipeText, recipeReviewedAt: reviewedAt },
  });
  resetTodayCache();
  res.json({ ok: true, recipeText, recipeReviewedAt: reviewedAt, reviewLeft: await prisma.lesson.count({ where: REVIEW_WHERE }) });
});

// ---------- видео ----------

/**
 * Очередь транскодинга. Один урок за раз: FFmpeg жадный до процессора, а на том
 * же сервере живёт бот, который обязан отвечать клиенткам в секундах.
 *
 * Сама очередь в памяти, но она НЕ единственный источник правды: настоящее
 * состояние — это `Lesson.status` в базе. Раньше перезапуск контейнера
 * (деплой, нехватка памяти) терял очередь молча, и уроки оставались в
 * «перекодируется» навсегда, ничем не подхватываемые. Теперь при старте
 * незаконченные уроки возвращаются в очередь сами (см. resumeUnfinished).
 */
const queue: string[] = [];

const transcodeJob = createBackgroundJob({
  scope: "video:queue",
  run: async () => {
    let done = 0;
    while (queue.length > 0) {
      const lessonId = queue.shift()!;
      try {
        await processLesson(lessonId, `${(env.publicBaseUrl || "").replace(/\/+$/, "")}/api/course/lessons`);
        done += 1;
      } catch (err) {
        // Урок уже помечен FAILED внутри processLesson; очередь продолжаем —
        // один битый файл не должен останавливать остальные.
        logError("video:queue", err);
      }
    }
    return done;
  },
  summary: (done) => `перекодировано уроков: ${done}`,
  startedNote: "Видео принято, идёт перекодировка",
  busyNote: "Видео принято, встало в очередь",
});

/** Поставить урок в очередь перекодировки. Единственная дверь в очередь снаружи —
 *  импортёр (importRoutes.ts) ходит через неё. */
export function enqueueTranscode(lessonId: string): StartResult {
  queue.push(lessonId);
  return transcodeJob.start();
}

/**
 * Поднять со дна то, что не доехало. Вызывается один раз при старте: урок с
 * исходником и статусом UPLOADED/PROCESSING — это либо оборванная перекодировка,
 * либо принятое видео, до которого не дошли руки. И то и другое надо доделать,
 * иначе владелец видит вечное «перекодируется» и не понимает, чего ждёт.
 */
export async function resumeUnfinishedTranscodes(): Promise<number> {
  const stuck = await prisma.lesson.findMany({
    where: { sourcePath: { not: null }, status: { in: ["UPLOADED", "PROCESSING"] } },
    select: { id: true },
  });
  if (stuck.length === 0) return 0;
  for (const lesson of stuck) queue.push(lesson.id);
  transcodeJob.start();
  return stuck.length;
}

courseAdminRouter.post("/admin/lessons/:id/video", videoUpload.single("file"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Файл не получен" });
    return;
  }
  const cleanup = () => fs.promises.rm(file.path, { force: true }).catch(() => undefined);
  // Связь оборвалась на середине отправки — обработчик до конца не дойдёт, и
  // принятый кусок файла остался бы на диске навсегда. Владелец грузит с
  // телефона по мобильной сети, где обрывы обычное дело.
  req.on("aborted", () => void cleanup());

  if (!VIDEO_MIME[file.mimetype]) {
    await cleanup();
    res.status(400).json({ error: "Поддерживаются MP4, MOV, MKV и WebM" });
    return;
  }
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) {
    await cleanup();
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const cfg = await storageConfig();
  if (!cfg) {
    await cleanup();
    res.status(409).json({ error: "Сначала заполните ключи хранилища в настройках" });
    return;
  }
  if (!(await ffmpegAvailable())) {
    await cleanup();
    res.status(500).json({ error: "На сервере нет ffmpeg — перекодировать нечем" });
    return;
  }

  // Кладём исходник в хранилище: на диске сервера ему не место, а держать его
  // нужно — вдруг придётся перекодировать заново.
  const key = `sources/${lesson.id}${path.extname(file.path)}`;
  try {
    // Потоком, а не через буфер: урок на два гигабайта, прочитанный в память,
    // убивал процесс по нехватке памяти вместе с очередью и буферами ответов.
    await putObjectStream(cfg, key, file.path, file.mimetype);
  } catch (err) {
    logError("courseAdmin:uploadSource", err);
    await cleanup();
    res.status(502).json({ error: "Хранилище не приняло файл. Проверьте ключи и попробуйте снова" });
    return;
  }
  await cleanup();

  await prisma.lesson.update({ where: { id: lesson.id }, data: { sourcePath: key, status: "UPLOADED" } });
  queue.push(lesson.id);
  const started = transcodeJob.start();
  res.json({ ok: true, note: started.note, queued: queue.length });
});

/** Повторить перекодировку — например, после сбоя или смены настроек. */
courseAdminRouter.post("/admin/lessons/:id/retranscode", async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson?.sourcePath) {
    res.status(409).json({ error: "У урока нет исходного файла — загрузите видео заново" });
    return;
  }
  queue.push(lesson.id);
  res.json(transcodeJob.start());
});

// ---------- фото рецепта ----------

courseAdminRouter.post("/admin/lessons/:id/photos", photoUpload.single("file"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file || !PHOTO_MIME[file.mimetype]) {
    res.status(400).json({ error: "Нужен файл JPG, PNG или WebP" });
    return;
  }
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const cfg = await storageConfig();
  if (!cfg) {
    res.status(409).json({ error: "Сначала заполните ключи хранилища в настройках" });
    return;
  }

  const key = `photos/${lesson.id}/${crypto.randomUUID()}${PHOTO_MIME[file.mimetype]}`;
  await putObject(cfg, key, file.buffer, file.mimetype);
  const photos = [...parseStringArray(lesson.recipePhotos), key];
  await prisma.lesson.update({ where: { id: lesson.id }, data: { recipePhotos: JSON.stringify(photos) } });
  res.json({ url: presignGet(cfg, key, 6 * 3600), key });
});

courseAdminRouter.delete("/admin/lessons/:id/photos", async (req, res) => {
  const parsed = z.object({ key: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужен key удаляемого фото" });
    return;
  }
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const photos = parseStringArray(lesson.recipePhotos).filter((p) => p !== parsed.data.key);
  await prisma.lesson.update({ where: { id: lesson.id }, data: { recipePhotos: JSON.stringify(photos) } });
  const cfg = await storageConfig();
  // Из хранилища удаляем ПОСЛЕ базы: осиротевший файл дешевле, чем ссылка на
  // несуществующее фото на странице урока.
  if (cfg) await deleteObject(cfg, parsed.data.key).catch((err) => logError("courseAdmin:deletePhoto", err));
  res.json({ ok: true });
});

// ---------- ученицы, устройства, вопросы ----------

courseAdminRouter.get("/admin/course-students", async (_req, res) => {
  const purchases = await prisma.purchase.findMany({
    where: { courseId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      // Устройства принадлежат человеку (одно окно на все курсы), поэтому берём
      // их с контакта; старые записи, привязанные к покупке, тоже там — их
      // contactId проставлен миграцией.
      contact: { select: { username: true, igUserId: true, devices: true } },
      progress: true,
      courseRef: { select: { title: true } },
    },
  });
  res.json({
    rows: purchases.map((p) => ({
      id: p.id,
      who: p.contact.username ? `@${p.contact.username}` : p.contact.igUserId,
      course: p.courseRef?.title ?? p.course,
      openedAt: p.firstOpenedAt,
      revoked: Boolean(p.revokedAt),
      lessonsStarted: p.progress.length,
      lessonsDone: p.progress.filter((x) => x.completedAt).length,
      devices: p.contact.devices.map((d) => ({
        id: d.id,
        userAgent: d.userAgent,
        city: d.lastCity,
        lastSeenAt: d.lastSeenAt,
        blocked: Boolean(d.blockedAt),
        blockedReason: d.blockedReason,
        offlineUntil: d.offlineKeyExpiresAt,
      })),
    })),
  });
});

/** Разблокировать или заблокировать устройство. Владельцу это нужно, когда
 *  ученица сменила телефон и упёрлась в лимит, или наоборот — когда ссылку
 *  явно передали. */
courseAdminRouter.post("/admin/course-devices/:id", async (req, res) => {
  const parsed = z.object({ blocked: z.boolean(), reason: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { blocked: true|false }" });
    return;
  }
  try {
    await prisma.device.update({
      where: { id: req.params.id },
      data: parsed.data.blocked
        ? { blockedAt: new Date(), blockedReason: parsed.data.reason ?? "Заблокировано владельцем" }
        : { blockedAt: null, blockedReason: null },
    });
    res.json({ ok: true });
  } catch (err) {
    logError("courseAdmin:device", err);
    res.status(404).json({ error: "Устройство не найдено" });
  }
});

/** Вопросы с платформы, на которые ещё не ответили. */
courseAdminRouter.get("/admin/course-chat", async (_req, res) => {
  const rows = await prisma.courseChatMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      lesson: { select: { title: true } },
      purchase: { include: { contact: { select: { username: true, igUserId: true } } } },
    },
  });
  res.json({
    unanswered: await unansweredCount(),
    rows: rows.map((m) => ({
      id: m.id,
      who: m.purchase.contact.username ? `@${m.purchase.contact.username}` : m.purchase.contact.igUserId,
      lesson: m.lesson?.title ?? null,
      fromStudent: m.fromStudent,
      byBot: m.byBot,
      text: m.text,
      answered: Boolean(m.readByOwnerAt),
      createdAt: m.createdAt,
    })),
  });
});

/**
 * Ответ ученице ПРЯМО ИЗ ПАНЕЛИ (inbox вопросов, 05.09.2026). Раньше ответить
 * можно было только реплаем в Telegram; здесь тот же путь записи
 * (chat.ts answerFromPanel → recordOwnerAnswer), так что ответ доходит до
 * приложения ученицы одинаково.
 */
courseAdminRouter.post("/admin/course-chat/:id/reply", async (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Напишите ответ" });
    return;
  }
  const answer = await answerFromPanel(req.params.id, parsed.data.text);
  if (!answer) {
    res.status(404).json({ error: "Вопрос не найден" });
    return;
  }
  resetTodayCache();
  res.json({ ok: true, id: answer.id, unanswered: await unansweredCount() });
});

const DRAFT_REASON: Record<Extract<PanelDraft, { draft: null }>["reason"], string> = {
  not_found: "Вопрос не найден",
  no_course: "Покупка не привязана к курсу — черновик собрать не по чему",
  budget: "Суточный лимит ИИ исчерпан — черновики до полуночи недоступны",
  no_material: "В рецептах и расшифровках ответа нет — лучше ответить самой",
  unavailable: "ИИ сейчас недоступен, попробуйте позже",
};

/**
 * ЧЕРНОВИК ОТ ИИ («Утро Ширин» §6, волна 2) — только текст в поле ответа,
 * ничего ученице не уходит: отправка по-прежнему через /reply выше.
 * Нет материала — {draft:null, reason}: честное «не знаю» вместо догадки.
 */
courseAdminRouter.post("/admin/course-chat/:id/draft", async (req, res) => {
  const result = await draftFromPanel(req.params.id);
  if (result.draft === null) {
    res.status(result.reason === "not_found" ? 404 : 200).json({ draft: null, reason: result.reason, note: DRAFT_REASON[result.reason] });
    return;
  }
  res.json(result);
});

/** Проверка хранилища кнопкой — тот же вызов, что раз в час делает фон. */
courseAdminRouter.post("/admin/storage-check", async (_req, res) => {
  res.json(await checkStorageReachable());
});

/**
 * ПОДКЛЮЧЕНИЕ ХРАНИЛИЩА ОДНОЙ ВСТАВКОЙ.
 *
 * Раньше владелец должен был перенести из Cloudflare четыре куска в четыре
 * поля — и застрял ровно на этом («не понял что куда копировать»). Теперь он
 * копирует страницу целиком, а разбираем её мы (storage/pasteCredentials.ts).
 *
 * Ответ НЕ содержит ни одного знака ключей: только что нашлось и заработало ли
 * хранилище. Вставленный текст никуда не пишется и нигде не логируется —
 * секретный ключ Cloudflare показывает один раз, и попасть в журнал он не
 * должен ни при каких обстоятельствах.
 */
courseAdminRouter.post("/admin/storage-paste", async (req: Request, res: Response) => {
  const parsedBody = z.object({ text: z.string().min(20).max(20_000) }).safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Вставьте текст со страницы Cloudflare" });
    return;
  }

  const found = parsePastedCredentials(parsedBody.data.text);
  const missing = missingParts(found);
  if (missing.length > 0) {
    res.status(422).json({
      error: `В том, что вставили, не нашлось: ${missing.join(", ")}. Скопируйте всю страницу Cloudflare целиком.`,
      found: summarize(found),
    });
    return;
  }

  await writeSettings({
    r2Endpoint: found.endpoint!,
    r2AccessKeyId: found.accessKeyId!,
    r2SecretKey: found.secretKey!,
  });

  // ИМЯ БАКЕТА СПРАШИВАЕМ У ХРАНИЛИЩА, а не выуживаем из текста. Ровно на этом
  // обожглись 03.09.2026: со страницы Cloudflare было вытащено слово «buckets»
  // из фразы «Specify bucket(s)», и при верных ключах хранилище отвечало
  // «NoSuchBucket». Список доступных бакетов знает только само хранилище.
  let bucket: string | null = null;
  let bucketNote: string | null = null;
  const cfg = await storageConfig();
  if (cfg) {
    try {
      const buckets = await listBuckets(cfg);
      if (buckets.length === 1) {
        bucket = buckets[0];
        await writeSettings({ r2Bucket: bucket });
      } else if (buckets.length > 1) {
        // Несколько бакетов — выбирать за владельца нельзя: не туда положим
        // уроки. Оставляем прежнюю настройку и говорим, из чего выбрать.
        bucketNote = `Хранилищ несколько: ${buckets.join(", ")}. Впишите нужное в поле «имя бакета» ниже.`;
      }
    } catch {
      // Список запрещён — так и есть у токена, выданного на ОДИН бакет (проверено
      // на проде 03.09.2026: ответ 403). Прежнее имя при этом остаётся в силе и
      // ничего не ломается. А вот если имени ещё нет вовсе — молчать нельзя:
      // владелец увидел бы «хранилище не отвечает» и не понял бы, что от него
      // требуется вписать одно короткое слово.
      if (!(await getSetting("r2Bucket"))?.trim()) {
        bucketNote =
          "Имя хранилища узнать не удалось: токен выдан на один бакет и список не отдаёт. " +
          "Впишите имя в поле «Хранилище видео: имя бакета» ниже — оно видно в Cloudflare в разделе R2.";
      }
    }
  }

  // Сразу пробуем достучаться до хранилища. Без этого владелец увидел бы
  // «сохранено» и ушёл, а узнал бы о неверном ключе только тогда, когда не
  // загрузился первый урок — то есть в самый неподходящий момент.
  const check = await checkStorageReachable();
  res.json({ ok: check.ok, detail: check.detail, found: summarize(found), bucket, bucketNote });
});
