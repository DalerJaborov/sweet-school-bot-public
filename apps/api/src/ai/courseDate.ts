import { getSetting } from "../db.js";
import { offsetMs } from "../dailyReport.js";
import type { ClientLanguage } from "./clientLanguage.js";

/**
 * ОДНА ДАТА ОЧНОГО КУРСА НА ВСЮ СИСТЕМУ.
 *
 * Было две настройки: `offlineCourseStartDate` (2026-10-03, по ней уходит
 * напоминание) и `offlineCourseDate` («3 октября», для показа людям). Держать
 * их согласованными приходилось руками, и это ровно тот вид ошибки, который не
 * замечают: разошлись — напоминание уходит не в тот день или не уходит вовсе,
 * и НИ ОДНОГО признака в интерфейсе. Именно так уже случилось однажды: в
 * уведомлении сестре месяцами стояло «15 сентября», зашитое в код.
 *
 * Теперь источник один — дата в формате ГГГГ-ММ-ДД. Человеческая надпись
 * выводится из неё кодом, на нужном языке. Настройка с текстом осталась только
 * как ручное переопределение на случай, когда набор описывают иначе
 * («с 3 по 10 октября»).
 */

const MONTHS_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const MONTHS_TG = [
  "январ", "феврал", "март", "апрел", "май", "июн",
  "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
];

/** Дата начала как календарный день, или null — не задана либо задана мусором. */
export async function offlineStartDate(): Promise<CalendarDay | null> {
  const raw = (await getSetting("offlineCourseStartDate"))?.trim();
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export type CalendarDay = { year: number; month: number; day: number };

/**
 * ДАТА, КОТОРУЮ МОЖНО ПОКАЗЫВАТЬ ЛЮДЯМ (решение владельца 05.09.2026).
 *
 * Дата набора, которая уже прошла, — это не «дата», а ложь: 4 октября бот и
 * сайт продолжили бы звать на курс 3 октября. Поэтому наружу (карточка бота,
 * /api/site/courses) уходит только дата не раньше сегодняшнего дня по Душанбе;
 * прошедшая или пустая — null, и тексты говорят «дата уточняется», пока
 * владелец не поставит новую в панели. «Сегодня» считается тем же сдвигом
 * часового пояса, что у вечерней сводки (dailyReport.offsetMs), — второго
 * определения суток в системе быть не должно.
 */
export async function upcomingOfflineStartDate(): Promise<CalendarDay | null> {
  const date = await offlineStartDate();
  if (!date) return null;
  const local = new Date(Date.now() + (await offsetMs()));
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return Date.UTC(date.year, date.month - 1, date.day) >= today ? date : null;
}

/** ГГГГ-ММ-ДД — формат настройки и API сайта. */
export function toIsoDay(date: CalendarDay): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** «3 октября» / «3 октябр» — надпись для людей, выведенная из той же даты. */
export function formatCourseDate(
  date: { month: number; day: number },
  language: ClientLanguage = "ru"
): string {
  const months = language === "tg" ? MONTHS_TG : MONTHS_RU;
  return `${date.day} ${months[date.month - 1]}`;
}

/**
 * Дата словами для сообщений. Порядок: ручное переопределение из настроек,
 * иначе вывод из календарной даты, иначе честное «не задана» — чтобы владелец
 * увидел пустое место, а не устаревшую дату прошлого набора.
 */
export async function courseDateLabel(language: ClientLanguage = "ru"): Promise<string> {
  const manual = (await getSetting("offlineCourseDate"))?.trim();
  if (manual) return manual;
  const date = await offlineStartDate();
  return date ? formatCourseDate(date, language) : "дата не задана в настройках";
}

/**
 * Дата начала прошла, а в настройках её не обновили. По этому признаку бот
 * предупреждает владельца: иначе он продолжит звать людей на курс, который уже
 * состоялся, и узнает об этом от рассерженной клиентки.
 */
export async function courseDateLooksStale(): Promise<boolean> {
  const date = await offlineStartDate();
  if (!date) return false;
  const start = Date.UTC(date.year, date.month - 1, date.day);
  return Date.now() - start > 2 * 86_400_000;
}
