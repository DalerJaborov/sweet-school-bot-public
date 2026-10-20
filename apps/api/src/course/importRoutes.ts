import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma, logError, logInfo } from "../db.js";
import { autoCatch } from "../asyncRoute.js";
import { storageConfig, putObject, putObjectStream } from "../storage/s3.js";
import { ffmpegAvailable, ffprobeAvailable, probeMedia } from "../storage/videoPipeline.js";
import { createBackgroundJob } from "../services/importService.js";
import { courseByCode } from "../services/courseCatalog.js";
import { diskState } from "../diskWatch.js";
import {
  detectParseMode,
  parseTelegramExport,
  readExportJson,
  resolveVideoFiles,
  type FolderVideo,
  type LessonCandidate,
  type LessonFileOverride,
  type ParseMode,
  type ParsedTelegramExport,
  type ResolvedLesson,
} from "./tgExport.js";
import { ocrRecipeCard, recipeCardToMarkdown, mergeRecipeCards, type RecipeCard } from "./cardOcr.js";
import { enqueueTranscode } from "./adminRoutes.js";

/**
 * ИМПОРТ УРОКОВ ИЗ ЭКСПОРТА TELEGRAM DESKTOP (владелец 03.09.2026).
 *
 * Бот через свой API историю группы прочитать не может и файлы больше 20 МБ не
 * скачивает — это ограничение самого Telegram. Поэтому владелец один раз
 * делает в Telegram Desktop «Экспорт истории чата» (JSON, с видео и фото),
 * папка копируется на сервер в /data/imports/<имя>, а дальше всё делает панель:
 * показывает найденные уроки с названиями и рецептами, даёт поправить и
 * запускает заливку в хранилище с перекодировкой.
 *
 * Три правила:
 *  • СНАЧАЛА ПОКАЗАТЬ, ПОТОМ ДЕЛАТЬ. Владелец видит список до запуска и правит
 *    названия — иначе «Урок 7» с подписью «видео» уехал бы в приложение как есть.
 *  • ПОВТОР БЕЗОПАСЕН. Каждый урок помнит, из какого сообщения пришёл
 *    (Lesson.importedFrom); второй запуск той же папки пропускает готовое.
 *  • НИЧЕГО В ПАМЯТИ. Видео льётся потоком (putObjectStream): урок на два
 *    гигабайта, прочитанный в буфер, убил бы процесс вместе с ботом.
 *
 * РЕАЛЬНЫЙ ЭКСПОРТ КАНАЛА (04.09.2026) добавил три вещи, которых не было в
 * учебной группе: карточка рецепта картинкой и тизер к каждому уроку
 * (режим «channel» в tgExport), файлы больше лимита экспорта, которые лежат
 * в video_files/ под своими именами и подбираются по длительности
 * (resolveVideoFiles), и оборванные файлы без moov atom — их ловит ffprobe
 * ДО запуска, а не ffmpeg посреди ночи.
 */

// autoCatch свой: обёртка adminRouter на вложенные роутеры не распространяется (см. today.ts).
export const importRouter = autoCatch(Router());

const IMPORT_ROOT = "/data/imports";
/** Меньше — не начинаем: перекодировке нужно место под временные файлы. */
const MIN_FREE_GB = 2;
const FOLDER_RE = /^[\w.-]{1,120}$/;
const VIDEO_DIR = "video_files";
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v)$/i;
/** Без ffprobe: меньше мегабайта на минуту урока — похоже на обрыв загрузки. */
const SUSPICIOUS_BYTES_PER_MIN = 1024 * 1024;
/** Сколько карточек одного урока читать через Gemini: обычно одна, редко две. */
const MAX_OCR_CARDS = 3;

function folderPath(name: string): string {
  return path.join(IMPORT_ROOT, name);
}

/**
 * Путь к файлу ИЗ result.json — строго внутри папки экспорта. Имена файлов
 * приходят из JSON, который мы не писали: «../../data/bot.db» в поле `file`
 * утащил бы в хранилище саму базу. Папку кладёт только владелец, но дверь
 * должна быть закрыта независимо от того, кто за ней стоит.
 */
function insideFolder(dir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const root = path.resolve(dir) + path.sep;
  const abs = path.resolve(dir, rel);
  return abs.startsWith(root) ? abs : null;
}

/** Размер папки с видео и число файлов — чтобы владелец понимал, что копировал. */
async function folderStats(dir: string): Promise<{ sizeGb: number; videoCount: number; hasResult: boolean }> {
  const videosDir = path.join(dir, VIDEO_DIR);
  let size = 0;
  let count = 0;
  try {
    for (const f of await fs.promises.readdir(videosDir)) {
      const st = await fs.promises.stat(path.join(videosDir, f)).catch(() => null);
      if (st?.isFile()) {
        size += st.size;
        count += 1;
      }
    }
  } catch {
    // папки с видео нет — экспорт без медиа
  }
  const hasResult = await fs.promises
    .stat(path.join(dir, "result.json"))
    .then((st) => st.isFile())
    .catch(() => false);
  return { sizeGb: Math.round((size / 1024 ** 3) * 10) / 10, videoCount: count, hasResult };
}

importRouter.get("/admin/imports/telegram", async (_req, res) => {
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(IMPORT_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && FOLDER_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    // /data/imports ещё не создавали — папок нет, это не ошибка
  }
  const folders = [];
  for (const name of names) folders.push({ name, ...(await folderStats(folderPath(name))) });
  res.json({ folders, disk: await diskState("/data"), job: importJob.status() });
});

/** Статус — РАНЬШЕ маршрута с :folder, иначе слово «status» примут за имя папки. */
importRouter.get("/admin/imports/telegram/status", (_req, res) => {
  res.json(importJob.status());
});

type ReadResult = { parsed: ParsedTelegramExport; warnings: string[] };

/**
 * Прочитать и разобрать result.json папки. Экспорт на десятки мегабайт
 * читается за секунду. Оборванный файл (экспорт прервали) не ошибка, а
 * предупреждение: сообщения до обрыва показываем, остальное — после
 * повторного экспорта.
 */
async function readExport(dir: string, requested: ParseMode | "auto"): Promise<ReadResult> {
  const raw = await fs.promises.readFile(path.join(dir, "result.json"), "utf8");
  const { json, truncated, recovered } = readExportJson(raw);
  const mode = requested === "auto" ? detectParseMode(json) : requested;
  const warnings: string[] = [];
  if (truncated) {
    warnings.push(
      `result.json оборван — экспорт в Telegram Desktop не был доведён до конца. Удалось прочитать ${recovered} сообщений; ` +
        "остальное появится после повторного экспорта (дождитесь надписи «Экспорт завершён»)."
    );
  }
  return { parsed: parseTelegramExport(json, { mode }), warnings };
}

function importKey(chatId: string, messageId: number): string {
  return `tg:${chatId}:${messageId}`;
}

/**
 * Прощупать все видео папки. Кеш по (путь, размер, mtime): владелец
 * открывает список уроков не один раз, а ffprobe тридцати файлов — секунды.
 */
type ProbeCacheEntry = { size: number; mtimeMs: number; video: FolderVideo };
const probeCache = new Map<string, ProbeCacheEntry>();

async function scanFolderVideos(dir: string): Promise<{ videos: FolderVideo[]; probed: boolean }> {
  const videosDir = path.join(dir, VIDEO_DIR);
  const names = await fs.promises.readdir(videosDir).catch(() => [] as string[]);
  const probed = await ffprobeAvailable();
  const videos: FolderVideo[] = [];
  for (const name of names) {
    if (!VIDEO_EXT.test(name)) continue;
    const abs = path.join(videosDir, name);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    const cached = probeCache.get(abs);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      videos.push(cached.video);
      continue;
    }
    const rel = `${VIDEO_DIR}/${name}`;
    let video: FolderVideo;
    if (probed) {
      const media = await probeMedia(abs);
      video = {
        file: rel,
        sizeBytes: st.size,
        durationSec: media?.durationSec ?? null,
        width: media?.width ?? null,
        height: media?.height ?? null,
        broken: media === null,
      };
    } else {
      video = { file: rel, sizeBytes: st.size, durationSec: null, width: null, height: null, broken: false };
    }
    probeCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, video });
    videos.push(video);
  }
  return { videos, probed };
}

/**
 * Без ffprobe о повреждении судим по размеру: у урока на 20 минут не может
 * быть 8 МБ. Грубо, зато ловит оборванные загрузки и на сервере без ffmpeg.
 */
function applySizeHeuristic(l: ResolvedLesson): void {
  const r = l.video;
  if (r.status !== "exported" || !l.durationSec || !r.sizeBytes) return;
  const expected = (l.durationSec / 60) * SUSPICIOUS_BYTES_PER_MIN;
  if (r.sizeBytes < expected) {
    r.status = "broken";
    r.note = `файл подозрительно маленький для ${Math.round(l.durationSec / 60)} мин — возможно, загрузка оборвалась; скачайте заново`;
  }
}

importRouter.get("/admin/imports/telegram/:folder", async (req, res) => {
  const folder = req.params.folder;
  if (!FOLDER_RE.test(folder)) {
    res.status(400).json({ error: "Странное имя папки" });
    return;
  }
  const modeParam = req.query.mode;
  const requested: ParseMode | "auto" = modeParam === "channel" || modeParam === "caption" ? modeParam : "auto";
  const dir = folderPath(folder);
  let read: ReadResult;
  try {
    read = await readExport(dir, requested);
  } catch (err) {
    logError("import:telegram:read", err);
    res.status(404).json({ error: "В папке нет result.json или он не читается. Экспортируйте чат в формате JSON." });
    return;
  }
  const { parsed, warnings } = read;

  const keys = parsed.lessons.map((l) => importKey(parsed.chatId, l.messageId));
  const existing = await prisma.lesson.findMany({
    where: { importedFrom: { in: keys } },
    select: { importedFrom: true, status: true },
  });
  const done = new Map(existing.map((l) => [l.importedFrom, l.status]));

  const { videos, probed } = await scanFolderVideos(dir);
  if (!probed) warnings.push("На сервере нет ffprobe — повреждённые файлы отличаем только по размеру, а невыгруженные подобрать не можем.");
  const broken = videos.filter((v) => v.broken);
  if (broken.length) {
    warnings.push(`Повреждённые файлы в video_files (загрузка оборвалась): ${broken.map((v) => path.basename(v.file)).join(", ")} — скачайте их заново.`);
  }

  const lessons = [];
  for (const l of resolveVideoFiles(parsed.lessons, videos)) {
    if (!probed) applySizeHeuristic(l);
    const status = done.get(importKey(parsed.chatId, l.messageId)) ?? null;
    const usable = l.video.status === "exported" || l.video.status === "resolved";
    lessons.push({
      ...l,
      fileExists: usable,
      sizeMb: Math.round(l.video.sizeBytes / 1024 ** 2),
      // Провалившийся импорт не считается сделанным — его можно повторить.
      alreadyImported: status !== null && status !== "FAILED",
    });
  }

  res.json({
    chatId: parsed.chatId,
    chatName: parsed.chatName,
    mode: parsed.mode,
    lessons,
    intro: parsed.intro,
    skipped: parsed.skipped,
    warnings,
    disk: await diskState("/data"),
  });
});

/** Путь из запроса панели: только внутри video_files/ папки экспорта. */
const videoFileSchema = z
  .string()
  .max(500)
  .regex(/^video_files\/[^/\\]+$/)
  .nullable()
  .optional();

const runSchema = z.object({
  folder: z.string().regex(FOLDER_RE),
  mode: z.enum(["auto", "caption", "channel"]).default("auto"),
  courseCode: z.enum(["COURSE50", "COURSE70"]),
  moduleTitle: z.string().trim().min(1).max(200),
  deleteSourceAfterUpload: z.boolean().default(true),
  /** Читать карточки рецептов через Gemini в recipeText (только пустые). */
  ocrCards: z.boolean().default(true),
  lessons: z
    .array(
      z.object({
        messageId: z.number().int(),
        title: z.string().trim().min(1).max(200),
        recipeText: z.string().max(20000).nullable(),
        include: z.boolean(),
        order: z.number().int().min(1).max(999),
        /** Файл, подобранный или выбранный в панели, когда экспорт его не выгрузил. */
        videoFile: videoFileSchema,
        teaserFile: videoFileSchema,
      })
    )
    .min(1)
    .max(300),
});

type RunInput = z.infer<typeof runSchema>;
type RunItem = RunInput["lessons"][number];

/** Выбор владельца по урокам → карта для resolveVideoFiles (см. run ниже). */
export function runOverrides(items: readonly Pick<RunItem, "messageId" | "videoFile" | "teaserFile">[]): Map<number, LessonFileOverride> {
  return new Map(items.map((l) => [l.messageId, { videoFile: l.videoFile ?? null, teaserFile: l.teaserFile ?? null }]));
}

/** Что задача получает при запуске — кладётся сюда роутом, читается внутри run. */
let pendingRun: RunInput | null = null;

type ImportResult = { created: number; skipped: number; errors: number; ocr: number };

const importJob = createBackgroundJob<ImportResult>({
  scope: "import:telegram",
  startedNote: "Импорт запущен — следите за прогрессом на этой странице",
  busyNote: "Импорт уже идёт, дождитесь окончания",
  summary: (r) => `создано ${r.created}, пропущено ${r.skipped}, ошибок ${r.errors}, карточек прочитано ${r.ocr}`,
  run: async (report) => {
    const input = pendingRun;
    pendingRun = null;
    if (!input) throw new Error("Импорт запущен без параметров");

    const dir = folderPath(input.folder);
    const { parsed } = await readExport(dir, input.mode);
    // ТЕ ЖЕ ФАЙЛЫ, ЧТО ПОКАЗАЛ ПРЕДПРОСМОТР. Урок с заглушкой «File exceeds…»
    // в экспорте файла не имеет — его подобрал resolveVideoFiles по
    // длительности. Раньше запуск брал «сырые» кандидаты из JSON, и если
    // панель не прислала videoFile, такой урок падал на «файл не найден».
    // Выбор владельца (videoFile/teaserFile из панели) идёт в подбор ПЕРВЫМ:
    // выбранный файл занят и выпадает из кандидатов соседей.
    const { videos } = await scanFolderVideos(dir);
    const byMessage = new Map(resolveVideoFiles(parsed.lessons, videos, runOverrides(input.lessons)).map((l) => [l.messageId, l]));
    const cfg = await storageConfig();
    if (!cfg) throw new Error("Хранилище не настроено");
    const course = await courseByCode(input.courseCode);
    if (!course) throw new Error(`Курс ${input.courseCode} не найден в каталоге — нажмите «Заполнить каталог» в «Курсах»`);

    // Раздел по названию внутри курса: повторный импорт в тот же раздел не
    // плодит «Уроки», «Уроки (2)».
    let module = await prisma.module.findFirst({ where: { courseId: course.id, title: input.moduleTitle } });
    if (!module) {
      const last = await prisma.module.findFirst({ where: { courseId: course.id }, orderBy: { order: "desc" } });
      module = await prisma.module.create({
        data: { courseId: course.id, title: input.moduleTitle, order: (last?.order ?? 0) + 1 },
      });
    }

    const chosen = input.lessons.filter((l) => l.include).sort((a, b) => a.order - b.order);
    const result: ImportResult = { created: 0, skipped: 0, errors: 0, ocr: 0 };
    const errors: { item: string; error: string }[] = [];
    report({ done: 0, total: chosen.length, current: null, errors });

    for (const item of chosen) {
      const candidate = byMessage.get(item.messageId);
      report({ current: item.title });
      try {
        if (!candidate) throw new Error("сообщение не найдено в экспорте");
        const key = importKey(parsed.chatId, candidate.messageId);
        const existing = await prisma.lesson.findUnique({ where: { importedFrom: key } });
        if (existing && existing.status !== "FAILED") {
          result.skipped += 1;
          continue;
        }
        const outcome = await importOne(cfg, module.id, key, item, candidate, dir, input, existing?.id ?? null);
        result.created += 1;
        if (outcome.ocr) result.ocr += 1;
      } catch (err) {
        result.errors += 1;
        errors.push({ item: item.title, error: err instanceof Error ? err.message : String(err) });
        logError("import:telegram:lesson", err);
      } finally {
        report({ done: result.created + result.skipped + result.errors, errors });
      }
    }
    logInfo("import:telegram", `папка ${input.folder} → курс ${input.courseCode}: ${JSON.stringify(result)}`);
    return result;
  },
});

/** Абсолютный путь к существующему файлу экспорта или понятная ошибка. */
async function requireFile(dir: string, rel: string, what: string): Promise<string> {
  const abs = insideFolder(dir, rel);
  const st = abs ? await fs.promises.stat(abs).catch(() => null) : null;
  if (!abs || !st?.isFile()) {
    throw new Error(`${what} ${rel || "(без имени)"} не найден — возможно, экспорт делали без видео или с лимитом размера`);
  }
  return abs;
}

/** Абсолютный путь, если файл экспорта существует; иначе null. */
async function existingFile(dir: string, rel: string): Promise<string | null> {
  const abs = insideFolder(dir, rel);
  const st = abs ? await fs.promises.stat(abs).catch(() => null) : null;
  return abs && st?.isFile() ? abs : null;
}

function imageMime(rel: string): string {
  return /\.png$/i.test(rel) ? "image/png" : /\.webp$/i.test(rel) ? "image/webp" : "image/jpeg";
}

async function importOne(
  cfg: NonNullable<Awaited<ReturnType<typeof storageConfig>>>,
  moduleId: string,
  importedFrom: string,
  item: RunItem,
  candidate: LessonCandidate,
  dir: string,
  input: Pick<RunInput, "deleteSourceAfterUpload" | "ocrCards">,
  retryLessonId: string | null
): Promise<{ ocr: boolean }> {
  // Файл — из панели (подобранный по длительности или выбранный владельцем),
  // иначе из экспорта.
  const videoRel = item.videoFile ?? candidate.videoFile;
  const videoAbs = await requireFile(dir, videoRel, "файл видео");
  // Тизер необязателен: нет файла — урок идёт без анонса, а не падает.
  const teaserRel = item.teaserFile ?? candidate.teaserFile;
  const teaserAbs = teaserRel ? await existingFile(dir, teaserRel) : null;

  // Порядок уникален внутри раздела: столкновение сдвигаем в хвост и идём
  // дальше, а не роняем весь импорт.
  const create = async (order: number) =>
    prisma.lesson.create({
      data: { moduleId, title: item.title, order, recipeText: item.recipeText, importedFrom, status: "UPLOADED" },
    });
  let lesson;
  if (retryLessonId) {
    lesson = await prisma.lesson.update({
      where: { id: retryLessonId },
      data: { title: item.title, recipeText: item.recipeText, recipeSource: null, status: "UPLOADED" },
    });
  } else {
    try {
      lesson = await create(item.order);
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err;
      const last = await prisma.lesson.findFirst({ where: { moduleId }, orderBy: { order: "desc" } });
      lesson = await create((last?.order ?? 0) + 1);
    }
  }

  let ocrDone = false;
  // Всё, что дальше, может упасть (сеть, хранилище). Урок уже создан — и без
  // этого catch он остался бы UPLOADED без sourcePath навсегда: повтор импорта
  // считал бы его сделанным, очередь при старте не подхватила бы, а в
  // приложении висело бы вечное «видео готовится» (ревью 03.09.2026).
  try {
    const ext = path.extname(videoRel) || ".mp4";
    const sourcePath = `sources/${lesson.id}${ext}`;
    await putObjectStream(cfg, sourcePath, videoAbs, candidate.mimeType || "video/mp4");

    let teaserPath: string | null = null;
    if (teaserAbs && teaserRel) {
      teaserPath = `sources/${lesson.id}-teaser${path.extname(teaserRel) || ".mp4"}`;
      await putObjectStream(cfg, teaserPath, teaserAbs, candidate.teaserMimeType || "video/mp4");
    }

    // Карточки рецепта — первыми: в приложении они и есть рецепт.
    const photos: string[] = [];
    const cardBuffers: { body: Buffer; mime: string }[] = [];
    const ordered = [...candidate.cardPhotos, ...candidate.photoFiles.filter((p) => !candidate.cardPhotos.includes(p))];
    for (const rel of ordered) {
      const abs = insideFolder(dir, rel);
      const body = abs ? await fs.promises.readFile(abs).catch(() => null) : null;
      if (!body) continue;
      const mime = imageMime(rel);
      const photoKey = `photos/${lesson.id}/${crypto.randomUUID()}${path.extname(rel) || ".jpg"}`;
      await putObject(cfg, photoKey, body, mime, "private, max-age=0");
      photos.push(photoKey);
      if (candidate.cardPhotos.includes(rel) && cardBuffers.length < MAX_OCR_CARDS) cardBuffers.push({ body, mime });
    }

    // РАСПОЗНАВАНИЕ КАРТОЧКИ — только в пустой рецепт, одна карточка = один
    // вызов, и любая неудача = урок без текста, а не без импорта.
    let recipeText = item.recipeText;
    // Структурированная копия того же рецепта (components/items) — для карточки
    // рецепта v2 (чекбоксы, пересчёт порции): markdown для этого не годится,
    // разбирать его обратно на клиенте ненадёжно. Пишем оба поля из одного
    // распознавания, одним проходом по карточкам.
    let recipeData: RecipeCard | null = null;
    let recipeSource: string | null = null;
    let title = item.title;
    if (input.ocrCards && !recipeText?.trim() && cardBuffers.length) {
      const parts: string[] = [];
      const parsedCards: RecipeCard[] = [];
      for (const card of cardBuffers) {
        const parsedCard = await ocrRecipeCard(card.body, card.mime);
        if (!parsedCard) continue;
        parts.push(recipeCardToMarkdown(parsedCard));
        parsedCards.push(parsedCard);
        // «Урок 7» — заглушка парсера; название с карточки честнее.
        if (parsedCard.title && /^урок\s+\d+$/i.test(title)) title = parsedCard.title.slice(0, 200);
      }
      if (parts.length) {
        recipeText = parts.join("\n\n");
        recipeData = mergeRecipeCards(parsedCards);
        recipeSource = "card-ocr";
        ocrDone = true;
      }
    }

    await prisma.lesson.update({
      where: { id: lesson.id },
      data: {
        sourcePath,
        teaserPath,
        recipePhotos: JSON.stringify(photos),
        recipeText,
        recipeData: recipeData ? JSON.stringify(recipeData) : null,
        recipeSource,
        title,
      },
    });
  } catch (err) {
    await prisma.lesson
      .update({ where: { id: lesson.id }, data: { status: "FAILED" } })
      .catch((e) => logError("import:telegram:markFailed", e));
    throw err;
  }
  enqueueTranscode(lesson.id);

  // Исходники уже в хранилище — на диске сервера они больше не нужны, а место
  // под следующие видео нужно.
  if (input.deleteSourceAfterUpload) {
    await fs.promises.rm(videoAbs, { force: true }).catch(() => undefined);
    if (teaserAbs) await fs.promises.rm(teaserAbs, { force: true }).catch(() => undefined);
  }
  return { ocr: ocrDone };
}

/**
 * УДАЛЕНИЕ ИСХОДНИКОВ ПОСЛЕ ИМПОРТА («Утро Ширин» §14). Папка экспорта на
 * 5 ГБ после заливки в хранилище нужна только как страховка; кнопка в мастере
 * освобождает диск без Далера и консоли. Три замка: имя только по FOLDER_RE
 * (никаких «..» и слэшей), путь строго под IMPORT_ROOT, и ничего, пока идёт
 * импорт — он читает эту папку прямо сейчас.
 */
export type RemoveFolderResult = { ok: true; freedGb: number } | { ok: false; status: 400 | 404 | 409; error: string };

export async function removeImportFolder(name: string, opts: { root?: string; running: boolean }): Promise<RemoveFolderResult> {
  const root = path.resolve(opts.root ?? IMPORT_ROOT);
  if (!FOLDER_RE.test(name)) return { ok: false, status: 400, error: "Странное имя папки" };
  const dir = path.resolve(root, name);
  if (!dir.startsWith(root + path.sep)) return { ok: false, status: 400, error: "Странное имя папки" };
  if (opts.running) return { ok: false, status: 409, error: "Импорт ещё идёт — удалить папку можно после окончания" };
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, status: 404, error: "Папки уже нет" };
  const freedGb = (await folderStats(dir)).sizeGb;
  await fs.promises.rm(dir, { recursive: true, force: true });
  logInfo("import:telegram", `папка ${name} удалена, освобождено ~${freedGb} ГБ`);
  return { ok: true, freedGb };
}

importRouter.delete("/admin/imports/telegram/:folder", async (req, res) => {
  const result = await removeImportFolder(req.params.folder, { running: importJob.isRunning() });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, freedGb: result.freedGb, disk: await diskState("/data") });
});

importRouter.post("/admin/imports/telegram/run", async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте параметры импорта", details: parsed.error.flatten() });
    return;
  }
  if (importJob.isRunning()) {
    res.status(409).json({ error: "Импорт уже идёт" });
    return;
  }
  if (!(await storageConfig())) {
    res.status(400).json({ error: "Хранилище видео не настроено — подключите его в «Настройках»" });
    return;
  }
  if (!(await ffmpegAvailable())) {
    res.status(400).json({ error: "На сервере нет ffmpeg — видео не перекодировать" });
    return;
  }
  const disk = await diskState("/data");
  if (disk && disk.freeGb < MIN_FREE_GB) {
    res.status(409).json({ error: `На диске свободно ${disk.freeGb} ГБ — мало для перекодировки. Освободите место.` });
    return;
  }
  if (!(await folderStats(folderPath(parsed.data.folder))).hasResult) {
    res.status(404).json({ error: "В папке нет result.json" });
    return;
  }
  // Повторная проверка СИНХРОННО, без await между ней и start(): между первой
  // проверкой и этой строкой четыре обращения к диску и хранилищу, и два
  // запроса подряд (двойной тап, две вкладки) оба проходили — второй
  // перезаписывал параметры и запускался сам после первого, без подтверждения.
  if (importJob.isRunning()) {
    res.status(409).json({ error: "Импорт уже идёт" });
    return;
  }
  pendingRun = parsed.data;
  const start = importJob.start();
  res.json({ ok: start.started, note: start.note });
});
