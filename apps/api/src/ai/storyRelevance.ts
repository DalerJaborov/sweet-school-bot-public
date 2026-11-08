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

/** Слова коротких комплиментов и реакций: на них отвечать нечем. Основа слова + любое окончание. */
const COMPLIMENT_STEMS = [
  "красив", "красот", "крут", "класс", "супер", "вау", "огонь", "шикарн", "прелест", "обожа", "люблю", "вкусн",
  "мило", "нежн", "топ", "молодец", "браво", "спасибо", "здорово", "отлично", "чудесн", "восхитительн", "ммм",
  "рахмат", "зебо", "офарин", "аъло", "бисёр", "хеле", "ташаккур", "хуб", "ура", "wow", "nice", "cool", "love",
  "beautiful", "great", "amazing", "yummy", "thanks", "thank", "you", "so", "very",
];

/**
 * Молчим только на эмодзи и короткие комплименты. Всё остальное («Подробнее», «Хочу научиться»,
 * «Где вы находитесь?», «Можно информацию?», «Маълумот диҳед») отдаём модели: она сама решит,
 * что это вопрос, а не реакция.
 */
export function isStoryChatter(text: string | null | undefined): boolean {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true; // только эмодзи и знаки
  if (words.length > 4) return false;
  return words.every((w) => COMPLIMENT_STEMS.some((s) => w.startsWith(s)));
}

export function storyReplyWorthAnswer(input: {
  storyCaption?: string | null;
  replyText?: string | null;
  /** Есть голосовое или другое вложение: не теряем. */
  hasMedia?: boolean;
}): boolean {
  if (input.hasMedia) return true;
  return !isStoryChatter(input.replyText);
}
