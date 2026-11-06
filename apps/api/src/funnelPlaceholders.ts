import { getSetting } from "./db.js";
import { courseDateLabel } from "./ai/courseDate.js";
import { detectClientLanguage } from "./ai/clientLanguage.js";

/**
 * ПОДСТАНОВКИ В ТЕКСТЕ ШАГОВ ВОРОНКИ: `{дата}` и `{время}`.
 *
 * ЗАЧЕМ. Дата офлайн-курса была вписана прямо в текст шага («15 сентябр»), а не
 * бралась из настройки. Курс переносили — а воронка продолжала звать на старый
 * день, и никакой экран этого не показывал (случай 13.10.2026: правили вручную
 * в базе, и правка не пережила переезд на новый сервер). Теперь в шаге пишут
 * `{дата}` и `{время}`, а значения берутся из тех же настроек, что и у сайта
 * и карточки бота: `offlineCourseStartDate` / `offlineCourseDate` и
 * `offlineCourseHours`. Перенесли курс в панели — воронка обновилась сама.
 *
 * Язык даты («20 ноябр» / «20 ноября») определяется по самому тексту шага.
 * Тексты без подстановок возвращаются как есть, без обращений к базе.
 */
const DATE_TOKEN = /\{\s*(дата|date)\s*\}/giu;
const TIME_TOKEN = /\{\s*(время|time)\s*\}/giu;

export async function renderFunnelText(text: string): Promise<string> {
  const needsDate = DATE_TOKEN.test(text);
  DATE_TOKEN.lastIndex = 0;
  const needsTime = TIME_TOKEN.test(text);
  TIME_TOKEN.lastIndex = 0;
  if (!needsDate && !needsTime) return text;

  let out = text;
  if (needsDate) {
    const language = detectClientLanguage(text);
    out = out.replace(DATE_TOKEN, await courseDateLabel(language));
  }
  if (needsTime) {
    const hours = (await getSetting("offlineCourseHours"))?.trim() || "время уточняется";
    out = out.replace(TIME_TOKEN, hours);
  }
  return out;
}
