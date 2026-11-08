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
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const MONTHS_TG = [
  "январ",
  "феврал",
  "март",
  "апрел",
  "май",
  "июн",
  "июл",
  "август",
  "сентябр",
  "октябр",
  "ноябр",
  "декабр",
];

/** Дата начала как календарный день, или null — не задана либо задана мусором. */
export async function offlineStartDate(): Promise<CalendarDay | null> {
  const raw = (await getSetting("offlineCourseStartDate"))?.trim();
  if (!raw) return null;
  return parseIsoDay(raw);
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
  return toIsoDay(date) >= (await localTodayIso()) ? date : null;
}

/** Сегодня по Душанбе, ГГГГ-ММ-ДД — для «впереди ли дата» и проверки в панели. */
export async function localTodayIso(): Promise<string> {
  const local = new Date(Date.now() + (await offsetMs()));
  return toIsoDay({ year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() });
}

/** ГГГГ-ММ-ДД → календарный день; мусор и несуществующие даты (31 февраля) → null. */
export function parseIsoDay(iso: string): CalendarDay | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** ГГГГ-ММ-ДД — формат настройки и API сайта. */
export function toIsoDay(date: CalendarDay): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** «3 октября» / «3 октябр» — надпись для людей, выведенная из той же даты. */
export function formatCourseDate(date: { month: number; day: number }, language: ClientLanguage = "ru"): string {
  const months = language === "tg" ? MONTHS_TG : MONTHS_RU;
  return `${date.day} ${months[date.month - 1]}`;
}

export const DATE_TBD_LABEL: Record<"ru" | "tg", string> = {
  ru: "дата следующего набора уточняется",
  tg: "санаи қабули оянда аниқ мешавад",
};

/**
 * Дата словами для сообщений (воронка {дата}, промт, уведомления о записи).
 *
 * 08.11.2026: только БУДУЩАЯ дата, иначе честное «уточняется». Раньше здесь
 * брались ручная надпись `offlineCourseDate` и сырая дата без проверки «не
 * прошла ли» — и та, и другая доживали до следующего набора: воронка и модель
 * звали людей на курс, который уже прошёл, хотя сайт и карточка уже писали
 * «уточняется». Ручная надпись больше не читается: второй источник даты рядом
 * с календарной — ровно та ошибка, от которой этот файл заводился.
 */
export async function courseDateLabel(language: ClientLanguage = "ru"): Promise<string> {
  const date = await upcomingOfflineStartDate();
  const lang = language === "tg" ? "tg" : "ru";
  return date ? formatCourseDate(date, lang) : DATE_TBD_LABEL[lang];
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
