import { prisma, logError } from "../db.js";
import { parseStringArray } from "../json.js";
import { storageConfig, getObject, deleteObject, type StorageConfig } from "../storage/s3.js";

/**
 * КОРЗИНА УРОКОВ («Утро Ширин» §19, 05.09.2026).
 *
 * «Удалить» в панели раньше стирало урок сразу — вместе с видео, рецептом и
 * прогрессом учениц, и единственной защитой было окно «Точно?», на которое
 * палец жмёт не глядя. Теперь удаление мягкое: ставится Lesson.deletedAt, урок
 * исчезает отовсюду (ученица, каталог, метрики, сертификат — все читают только
 * deletedAt = null), но 24 часа его можно вернуть одной кнопкой. Потом
 * purgeTrashedLessons убирает строку (прогресс и чат — каскадом) и файлы в
 * хранилище.
 *
 * Файлы удаляются ПОСЛЕ отсчёта, а не сразу: пока урок в корзине, его можно
 * вернуть ровно таким, каким он был, — с видео, обложками и фото.
 */

export const TRASH_TTL_MS = 24 * 60 * 60_000;

export type TrashRow = {
  id: string;
  title: string;
  order: number;
  module: string;
  course: string;
  deletedAt: Date;
  purgeAt: Date;
};

const TRASH_INCLUDE = { module: { select: { title: true, course: { select: { title: true } } } } } as const;

/** Уникальность (moduleId, order): пока урок лежит в корзине, его номер
 *  занят. Чтобы новый урок мог встать на то же место, номер корзинного урока
 *  переносится в отрицательную зону — там никто не живёт. */
function parkedOrder(now: Date): number {
  return -(Math.floor(now.getTime() / 1000) % 1_000_000_000);
}

/** Мягко удалить. null — урока нет или он уже в корзине. */
export async function softDeleteLesson(id: string, now = new Date()): Promise<{ undoUntil: Date } | null> {
  const lesson = await prisma.lesson.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!lesson) return null;
  await prisma.lesson.update({ where: { id }, data: { deletedAt: now } });
  return { undoUntil: new Date(now.getTime() + TRASH_TTL_MS) };
}

/**
 * Вернуть из корзины. Урок встаёт на свой прежний номер; если это место
 * успели занять новым уроком — в конец раздела (порядок можно поправить, а
 * потерять урок — нет).
 */
export async function restoreLesson(id: string): Promise<{ order: number } | null> {
  const lesson = await prisma.lesson.findFirst({ where: { id, deletedAt: { not: null } }, select: { id: true, moduleId: true, order: true } });
  if (!lesson) return null;
  let order = lesson.order;
  const taken = order < 0 ? true : Boolean(await prisma.lesson.findFirst({ where: { moduleId: lesson.moduleId, order, id: { not: id } }, select: { id: true } }));
  if (taken) {
    const last = await prisma.lesson.findFirst({ where: { moduleId: lesson.moduleId, id: { not: id } }, orderBy: { order: "desc" }, select: { order: true } });
    order = Math.max(0, last?.order ?? 0) + 1;
  }
  await prisma.lesson.update({ where: { id }, data: { deletedAt: null, order } });
  return { order };
}

/** Освободить номер корзинного урока, если новый урок хочет встать на его
 *  место. true — место освобождено, можно повторить создание. */
export async function vacateTrashedOrder(moduleId: string, order: number, now = new Date()): Promise<boolean> {
  const occupant = await prisma.lesson.findFirst({ where: { moduleId, order, deletedAt: { not: null } }, select: { id: true } });
  if (!occupant) return false;
  await prisma.lesson.update({ where: { id: occupant.id }, data: { order: parkedOrder(now) } });
  return true;
}

/** Что лежит в корзине и ещё не вычищено. */
export async function listTrash(now = new Date()): Promise<TrashRow[]> {
  const rows = await prisma.lesson.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    include: TRASH_INCLUDE,
  });
  return rows
    .filter((l) => l.deletedAt)
    .map((l) => ({
      id: l.id,
      title: l.title,
      order: l.order,
      module: l.module.title,
      course: l.module.course.title,
      deletedAt: l.deletedAt as Date,
      purgeAt: new Date((l.deletedAt as Date).getTime() + TRASH_TTL_MS),
    }))
    .filter((r) => r.purgeAt.getTime() > now.getTime());
}

type LessonFiles = {
  hlsPath: string | null;
  sourcePath: string | null;
  posterPath: string | null;
  coverPath: string | null;
  storyPath: string | null;
  teaserPath: string | null;
  teaserMp4Path: string | null;
  recipePhotos: string;
  attachments: string;
};

/** Сегменты HLS перечисляются по плейлистам: списка объектов по префиксу у
 *  хранилища мы не просим, а манифесты и так знают каждый файл. */
async function hlsKeys(cfg: StorageConfig, hlsPath: string): Promise<string[]> {
  const prefix = hlsPath.replace(/\/master\.m3u8$/, "");
  const keys = new Set<string>([hlsPath]);
  const master = await getObject(cfg, hlsPath);
  if (!master) return [...keys];
  const variants = master
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const variant of variants) {
    const variantKey = `${prefix}/${variant}`;
    keys.add(variantKey);
    const dir = variantKey.replace(/\/[^/]+$/, "");
    const playlist = await getObject(cfg, variantKey);
    if (!playlist) continue;
    for (const line of playlist.toString("utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) keys.add(`${dir}/${t}`);
    }
  }
  return [...keys];
}

/** Все ключи урока в хранилище. Экспортировано ради тестов. */
export async function lessonStorageKeys(cfg: StorageConfig, lesson: LessonFiles): Promise<string[]> {
  const keys = new Set<string>();
  for (const k of [lesson.sourcePath, lesson.posterPath, lesson.coverPath, lesson.storyPath, lesson.teaserPath, lesson.teaserMp4Path]) {
    if (k) keys.add(k);
  }
  for (const k of parseStringArray(lesson.recipePhotos)) keys.add(k);
  try {
    const attachments = JSON.parse(lesson.attachments) as unknown;
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        const p = (a as { path?: unknown })?.path;
        if (typeof p === "string" && p) keys.add(p);
      }
    }
  } catch {
    // Битый JSON вложений — нечего удалять, строку это не спасает от чистки.
  }
  if (lesson.hlsPath) for (const k of await hlsKeys(cfg, lesson.hlsPath)) keys.add(k);
  return [...keys];
}

/**
 * Часовая чистка: уроки, пролежавшие в корзине дольше суток, — стереть файлы и
 * строку. Строка удаляется только после того, как файлы ушли (или хранилище
 * не настроено — тогда удалять нечего): иначе объекты остались бы в бакете
 * без единой ссылки на них. Ошибка на одном уроке не останавливает остальные.
 */
export async function purgeTrashedLessons(now = new Date()): Promise<{ purged: number; failed: number }> {
  const threshold = new Date(now.getTime() - TRASH_TTL_MS);
  const expired = await prisma.lesson.findMany({ where: { deletedAt: { not: null, lte: threshold } } });
  if (expired.length === 0) return { purged: 0, failed: 0 };
  const cfg = await storageConfig();
  let purged = 0;
  let failed = 0;
  for (const lesson of expired) {
    try {
      if (cfg) {
        for (const key of await lessonStorageKeys(cfg, lesson)) await deleteObject(cfg, key);
      }
      await prisma.lesson.delete({ where: { id: lesson.id } });
      purged += 1;
    } catch (err) {
      failed += 1;
      logError("lessonTrash:purge", err);
    }
  }
  return { purged, failed };
}
