import { formatCourseDate, upcomingOfflineStartDate } from "./ai/courseDate.js";
import { hoursValue, parseHours } from "./ai/offlineFacts.js";
import { getOfflineFacts } from "./services/salesTextsService.js";
import { detectClientLanguage } from "./ai/clientLanguage.js";

/**
 * ПОДСТАНОВКИ В ТЕКСТЕ ШАГОВ ВОРОНКИ: `{дата}` и `{время}`.
 *
 * ЗАЧЕМ. Дата офлайн-курса была вписана прямо в текст шага («15 сентябр»), а не
 * бралась из настройки. Курс переносили — а воронка продолжала звать на старый
 * день, и никакой экран этого не показывал (случай 13.10.2026: правили вручную
 * в базе, и правка не пережила переезд на новый сервер). Теперь в шаге пишут
 * `{дата}` и `{время}`, а значения берутся из тех же настроек, что и у сайта
 * и карточки бота (раздел «Цены и даты»): дата — только будущая, иначе
 * «дата следующего набора уточняется». Перенесли курс — воронка обновилась сама.
 *
 * Язык даты («20 ноябр» / «20 ноября») определяется по самому тексту шага.
 * Тексты без подстановок возвращаются как есть, без обращений к базе.
 */
const DATE_TOKEN = /\{\s*(дата|date)\s*\}/giu;
const TIME_TOKEN = /\{\s*(время|time)\s*\}/giu;

export const FUNNEL_DATE_TBD = { ru: "(дата уточняется)", tg: "(сана ҳоло аниқ нест)" } as const;

export async function renderFunnelText(text: string): Promise<string> {
  const needsDate = DATE_TOKEN.test(text);
  DATE_TOKEN.lastIndex = 0;
  const needsTime = TIME_TOKEN.test(text);
  TIME_TOKEN.lastIndex = 0;
  if (!needsDate && !needsTime) return text;

  let out = text;
  if (needsDate) {
    const language = detectClientLanguage(text);
    // Даты нет — вставка в скобках, чтобы фраза шага осталась грамматичной в любом
    // месте: «Курс начнётся (дата уточняется), записывайтесь».
    const start = await upcomingOfflineStartDate();
    const lang = language === "tg" ? "tg" : "ru";
    out = out.replace(DATE_TOKEN, start ? formatCourseDate(start, lang) : FUNNEL_DATE_TBD[lang]);
  }
  if (needsTime) {
    // Те же часы, что в карточке бота и на сайте (раздел «Цены и даты»),
    // а не сырая настройка: пустая давала «время уточняется», хотя часы известны.
    const facts = await getOfflineFacts();
    const range = parseHours(facts.hours);
    out = out.replace(TIME_TOKEN, range ? hoursValue(range) : facts.hours.trim() || "время уточняется");
  }
  return out;
}
