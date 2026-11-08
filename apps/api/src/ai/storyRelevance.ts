/**
 * ОТВЕТ НА НАШУ ИСТОРИЮ: отвечаем, только если речь про курсы (владелец 08.11.2026).
 * Историю читаем по подписи (Graph отдаёт подпись; текст и стикеры поверх картинки через API
 * недоступны), поэтому смотрим ещё и на сам ответ клиента. Реакция-эмодзи, «круто», «красиво»
 * — молчание: продавать там нечего.
 *
 * Слова про десерты сюда НЕ входят: «красивый торт» на историю с тортом — это комплимент,
 * а не заявка. Названия десертов не переводим и не трогаем.
 */
const COURSE_WORDS = new RegExp(
  [
    "курс",
    "обучен",
    "урок",
    "запис",
    "записат",
    "цена",
    "стоит",
    "сколько",
    "оплат",
    "рассрочк",
    "рецепт",
    "офлайн",
    "онлайн",
    "дарс",
    "нарх",
    "чанд",
    "сабти",
    "ном(?:нависӣ|навис)",
    "омӯзиш",
    "омузиш",
    "тарзи пухтан",
    "мастер-?класс",
    "\\bcourse\\b",
    "\\bprice\\b",
    "how much",
  ].join("|"),
  "iu",
);

/** Метка входящего ответа на историю, на который мы молчим осознанно (см. webhook.ts, aiReplyRetry.ts). */
export const QUIET_STORY_PAYLOAD = "story:quiet";

export function mentionsCourse(text: string | null | undefined): boolean {
  return !!text && COURSE_WORDS.test(text);
}

export function storyReplyWorthAnswer(input: { storyCaption?: string | null; replyText?: string | null }): boolean {
  return mentionsCourse(input.storyCaption) || mentionsCourse(input.replyText);
}
