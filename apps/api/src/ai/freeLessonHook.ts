import { getSetting, logError } from "../db.js";
import { env } from "../env.js";

/**
 * «КРЮЧОК» — БЕСПЛАТНЫЙ ПЕРВЫЙ УРОК (решение владельца 08.11.2026).
 *
 * Сам урок и форма записи уже есть на сайте (site/freeLesson.ts, настройки
 * freeLessonEnabled / freeLessonId: человек оставляет имя и телефон — это заявка, а не
 * просто просмотр). Боту остаётся одно: уметь про него рассказать. Блок попадает в промт
 * ТОЛЬКО когда владелец включил урок и он реально готов; выключен — бот про него молчит,
 * правило 16 в prompts.ts запрещает его выдумывать.
 *
 * Бот не продаёт «в лоб»: урок предлагается один раз, отдельным сообщением, и никогда в
 * одной фразе с просьбой об оплате (правило 23 в prompts.ts).
 */
export function freeLessonUrl(): string {
  const base = (env.publicBaseUrl || "https://shirinsweets.online").replace(/\/+$/, "");
  return `${base}/online-kurs#free-lesson-island`;
}

export function buildFreeLessonBlock(url: string): string {
  return (
    "\n\nБЕСПЛАТНЫЙ УРОК (включён владельцем — он настоящий). Ссылка: " +
    url +
    ". Это твой главный способ мягко заинтересовать человека, который сомневается или просто " +
    "присматривается. Предложи его ОДИН раз за разговор — когда человек спрашивает, что внутри курса, " +
    "как учит Ширин, сколько стоит, говорит «подумаю», «дорого», «хочу сначала посмотреть». " +
    "Ссылку дай отдельным коротким сообщением (раздели строкой «---»). Скажи честно: на сайте нужно " +
    "оставить имя и телефон, после этого урок откроется. Не предлагай его тому, кто уже купил курс или " +
    "прямо сказал «я оплачиваю». Предложение урока и просьба об оплате никогда не стоят в одном сообщении."
  );
}

/** Пустая строка, если урок выключен или не готов (тогда бот про него молчит). */
export async function freeLessonBlock(): Promise<string> {
  try {
    const [enabled, id] = await Promise.all([getSetting("freeLessonEnabled"), getSetting("freeLessonId")]);
    if (enabled !== "true" || !id) return "";
    // Динамически: этот модуль тянет за собой хранилище и видео, а ai.ts должен
    // подниматься и без них.
    const { availableFreeLesson } = await import("../site/freeLesson.js");
    if (!(await availableFreeLesson())) return "";
    return buildFreeLessonBlock(freeLessonUrl());
  } catch (err) {
    logError("ai:freeLessonBlock", err);
    return "";
  }
}
