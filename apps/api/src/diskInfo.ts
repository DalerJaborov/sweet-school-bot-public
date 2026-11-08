import fs from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { logError, logInfo, logWarn } from "./db.js";
import { MEDIA_DIR } from "./upload.js";

/**
 * МЕСТО НА ДИСКЕ — БЕЗ УВЕДОМЛЕНИЙ В TELEGRAM (08.11.2026).
 *
 * Владелец решил убрать сообщения «Место на диске»: они приходили без пользы.
 * Остались `diskState` (его показывают /health и импорт видео) и чистка
 * брошенных временных файлов раз в час. Нехватка места пишется в журнал
 * (logWarn), в Telegram не уходит.
 */

/** Ниже этой доли свободного места — запись в журнал. */
const WARN_FREE_PCT = 15;

/** Временные файлы загрузки видео: их пишет multer до отправки в хранилище.
 *  Оборванная загрузка оставляет файл навсегда — обработчик роута до очистки
 *  просто не доходит. */
const TMP_DIR = path.join(MEDIA_DIR, "course-tmp");
/** Через сколько часов недоделанный временный файл считается брошенным. */
const TMP_STALE_HOURS = 24;

export type DiskState = { freePct: number; freeGb: number; totalGb: number };

/** Сколько свободно на разделе с данными. null — узнать не удалось (не Linux,
 *  нет прав): тогда просто молчим, а не считаем это поводом для тревоги. */
export async function diskState(dir = MEDIA_DIR): Promise<DiskState | null> {
  try {
    const st = await statfs(dir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (!total) return null;
    return {
      freePct: Math.round((free / total) * 100),
      freeGb: Math.round((free / 1024 ** 3) * 10) / 10,
      totalGb: Math.round(total / 1024 ** 3),
    };
  } catch {
    return null;
  }
}

/**
 * Удаляет брошенные временные файлы загрузки. Безопасно по построению: в
 * course-tmp попадает только то, что multer положил в процессе приёма видео, и
 * успешная загрузка удаляет свой файл сама. Всё, что пролежало сутки, — это
 * оборванная отправка.
 */
export async function cleanupTempUploads(): Promise<number> {
  let removed = 0;
  try {
    const entries = await fs.promises.readdir(TMP_DIR).catch(() => [] as string[]);
    const deadline = Date.now() - TMP_STALE_HOURS * 3_600_000;
    for (const name of entries) {
      const full = path.join(TMP_DIR, name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || !st.isFile() || st.mtimeMs > deadline) continue;
      await fs.promises.rm(full, { force: true });
      removed += 1;
    }
    if (removed > 0) logInfo("disk", `удалено брошенных временных файлов: ${removed}`);
  } catch (err) {
    logError("disk:cleanupTemp", err);
  }
  return removed;
}

/** Раз в час: чистим временные файлы и, если места мало, пишем в журнал. */
export async function runDiskMaintenance(): Promise<void> {
  await cleanupTempUploads();
  const state = await diskState();
  if (state && state.freePct < WARN_FREE_PCT) logWarn("disk", `свободно ${state.freePct}% (${state.freeGb} ГБ)`);
}
