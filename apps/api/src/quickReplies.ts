import { getSetting } from "./db.js";

/**
 * ГОТОВЫЕ ОТВЕТЫ НА «СЕРУЮ ЗОНУ» — вопросы не про курс и не про рецепт, на
 * которые бот сегодня просто замолкает и зовёт Ширин (см. ai.ts `callOwnerToChat`).
 *
 * Раньше единственным вариантом было напечатать ответ руками с телефона.
 * Панель админки для этого НЕ подходит — Ширин ведёт переписку прямо в
 * приложении Instagram и никогда не открывает панель (решение уже принято,
 * см. историю проекта). Поэтому кнопки живут там, где Ширин и владелец их и
 * так нажимают каждый день — под карточкой в Telegram (см. telegram.ts,
 * telegramWebhook.ts).
 *
 * Список хранится в Setting как JSON, а не в коде: чтобы поменять текст
 * ответа, не нужен деплой — правится через `/admin/settings` (ключ
 * `quickReplies`) или напрямую в базе.
 */
export type QuickReply = { label: string; text: string };

const SETTING_KEY = "quickReplies";

/** Значения по умолчанию — тот же тон, что у бота (душанбинский диалект,
 *  «апачон», без канцелярита). Используются, пока владелец не задал свои. */
export const DEFAULT_QUICK_REPLIES: QuickReply[] = [
  {
    label: "Рецепты — в чат группы",
    text: "По рецептам у нас чат в телеграм-группе — напишите туда, там отвечаем на все вопросы",
  },
  {
    label: "Не по теме курсов",
    text: "Извините, этим я не занимаюсь — тут только про курсы кондитерского дела",
  },
  {
    label: "Скидку не делаем",
    text: "Скидку, к сожалению, сделать не можем — цена на курс одна для всех",
  },
  {
    label: "Свяжется чуть позже",
    text: "Извините за ожидание — Ширин освободится и сама вам ответит, чуть позже",
  },
];

/** Читает список из Setting; при отсутствии или битом JSON — дефолты, а не
 *  пустой список (иначе кнопки под уведомлением молча исчезнут). */
export async function getQuickReplies(): Promise<QuickReply[]> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return DEFAULT_QUICK_REPLIES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_QUICK_REPLIES;
    const clean = parsed.filter(
      (item): item is QuickReply =>
        !!item && typeof item === "object" && typeof (item as QuickReply).label === "string" && typeof (item as QuickReply).text === "string"
    );
    return clean.length > 0 ? clean : DEFAULT_QUICK_REPLIES;
  } catch {
    return DEFAULT_QUICK_REPLIES;
  }
}
