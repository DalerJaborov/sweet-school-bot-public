import fs from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { getSetting, logError, logInfo, logWarn } from "./db.js";
import { ownerAlertChatIds, sendTelegramMessage } from "./telegram.js";
import { MEDIA_DIR } from "./upload.js";

/**
 * СЛЕЖЕНИЕ ЗА МЕСТОМ НА ДИСКЕ.
 *
 * ЗАЧЕМ. Это самый тихий из всех отказов. Когда диск заполняется, SQLite
 * перестаёт писать — и бот принимает вебхуки, но не может сохранить ни
 * сообщение, ни ответ. Снаружи это выглядит как «бот замолчал», причём сразу
 * для всех, а в логе только однотипные ошибки записи, которых никто не читает.
 *
 * Найдено 03.09.2026: бэкапы загрузок росли на 1,4 ГБ в сутки при 25 ГБ
 * свободного места. До полного диска оставалось около семнадцати дней, и ни
 * одного предупреждения на этом пути не было предусмотрено.
 *
 * Порог сознательно высокий (15%): предупреждать надо тогда, когда ещё есть
 * недели на разбор, а не когда осталось несколько часов.
 */

/** Ниже этой доли свободного места — тревога владельцу. */
const WARN_FREE_PCT = 15;
/** Ниже этой — тревога срочная, повторяется чаще. */
const CRITICAL_FREE_PCT = 7;
/** Не чаще раза в сутки при обычной нехватке, раз в 4 часа при критической. */
const WARN_COOLDOWN_MS = 24 * 3_600_000;
const CRITICAL_COOLDOWN_MS = 4 * 3_600_000;

/** Временные файлы загрузки видео: их пишет multer до отправки в хранилище.
 *  Оборванная загрузка оставляет файл навсегда — обработчик роута до очистки
 *  просто не доходит. */
const TMP_DIR = path.join(MEDIA_DIR, "course-tmp");
/** Через сколько часов недоделанный временный файл считается брошенным. */
const TMP_STALE_HOURS = 24;

let lastAlertAt = 0;

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

/**
 * Раз в час: чистим временные файлы и, если места мало, пишем владельцу.
 * Тревога с задержкой между повторами — иначе она превратится в шум, который
 * перестанут читать (ровно так уже вышло с ложными тревогами о зависших
 * задачах 03.09.2026).
 */
export async function checkDisk(): Promise<void> {
  await cleanupTempUploads();

  const state = await diskState();
  if (!state) return;

  if (state.freePct >= WARN_FREE_PCT) {
    lastAlertAt = 0; // место освободили — следующая тревога придёт сразу
    return;
  }

  const critical = state.freePct < CRITICAL_FREE_PCT;
  const cooldown = critical ? CRITICAL_COOLDOWN_MS : WARN_COOLDOWN_MS;
  if (Date.now() - lastAlertAt < cooldown) return;
  lastAlertAt = Date.now();

  const message =
    `${critical ? "🔴" : "🟠"} Место на диске школы: свободно ${state.freePct}% ` +
    `(${state.freeGb} ГБ из ${state.totalGb} ГБ)\n\n` +
    (critical
      ? "Когда диск заполнится, бот перестанет сохранять сообщения и замолчит для всех. Нужно освободить место сегодня."
      : "Пока не страшно, но само не рассосётся. Больше всего занимают архивы в /backups/school.");

  logWarn("disk", `свободно ${state.freePct}% (${state.freeGb} ГБ)`);

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await ownerAlertChatIds())[0]; // личный чат владельца, иначе чат сводок (telegram.ts)
  if (!botToken || !chatId) return;
  await sendTelegramMessage(botToken, chatId, message).catch((err) => logError("disk:alert", err));
}
