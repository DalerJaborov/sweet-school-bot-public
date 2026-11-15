import type { PriceTable } from "../prices.js";
import { COURSE_50, COURSE_70 } from "../prices.js";
import type { ClientLanguage } from "./clientLanguage.js";
import { DEFAULT_SALES_TEXTS, type SalesTexts } from "./prompts.js";

/**
 * ГОТОВЫЕ ВОПРОСЫ INSTAGRAM И РЕКЛАМЫ META («часто задаваемые» под кнопкой «Написать»).
 *
 * Instagram и реклама «клик в переписку» сами подсовывают новому человеку готовые
 * вопросы, и тот нажимает их первым сообщением. Это РУССКИЕ тексты, которые
 * нажимают таджикоязычные люди. Разбор 16.11.2026: после #86 бот отвечал на них
 * по-русски и без кнопок меню, и 40% таких людей больше не писали.
 *
 * Поэтому (16.11.2026):
 *  - ответ по-таджикски, кроме случая, когда человек уже писал по-русски своими
 *    словами (ai/instagramFaqReply.ts::faqLanguage);
 *  - первым сообщением — короткий ответ по сути и следом меню воронки с кнопками
 *    (funnel.ts::handleIncomingDm), без второго «Ассалому алейкум»;
 *  - факты: курс навсегда, сертификат входит (текст из «Тексты и цены»), рецепты
 *    только курсом, с вами Ширин. Цены из «Цены и даты».
 *
 * СПИСОК ВОПРОСОВ — здесь, одним местом. Тексты задаёт Meta/реклама, они меняются
 * редко; новый вариант владелец добавляет без выкатки настройкой
 * `instagramFaqExtra` (строки «вид: текст вопроса»), она ДОПОЛНЯЕТ список, а не
 * подменяет его (ai/instagramFaqReply.ts).
 */
export type InstagramFaq = "duration" | "length" | "single_recipes" | "certificate" | "about" | "talk";
export const INSTAGRAM_FAQ_KINDS: readonly InstagramFaq[] = [
  "duration",
  "length",
  "single_recipes",
  "certificate",
  "about",
  "talk",
];

/** Вопрос без знаков и регистра; «kursa» — так Instagram иногда пишет латиницей. */
export function normalizeFaqText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/kursa/g, "курса")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FAQ: { kind: InstagramFaq; re: RegExp }[] = [
  { kind: "duration", re: /^как долго доступен курс$/u },
  { kind: "length", re: /^как долго длится курс$/u },
  { kind: "single_recipes", re: /^можно ли купить отдельные рецепты$/u },
  { kind: "certificate", re: /^включает ли стоимость курса сертификат$/u },
  { kind: "about", re: /^расскажите подробнее о вашей компании$/u },
  { kind: "talk", re: /^могу ли я с кем нибудь пообщаться$/u },
];

/** Дополнительные тексты из настройки: уже нормализованные «текст → вид». */
export type FaqExtras = ReadonlyMap<string, InstagramFaq>;

export function detectInstagramFaq(text: string | null | undefined, extras?: FaqExtras): InstagramFaq | null {
  const n = normalizeFaqText(text ?? "");
  if (!n) return null;
  return FAQ.find((f) => f.re.test(n))?.kind ?? extras?.get(n) ?? null;
}

/** Строки настройки «вид: текст» → словарь. Неизвестный вид или пустая строка пропускаются. */
export function parseFaqExtras(raw: string | null | undefined): Map<string, InstagramFaq> {
  const out = new Map<string, InstagramFaq>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = /^\s*([a-z_]+)\s*:\s*(.+)$/u.exec(line);
    if (!m) continue;
    const kind = m[1] as InstagramFaq;
    if (!INSTAGRAM_FAQ_KINDS.includes(kind)) continue;
    const n = normalizeFaqText(m[2]);
    if (n) out.set(n, kind);
  }
  return out;
}

/**
 * Ответ по сути — одно-два коротких предложения, без вопроса в конце. Его шлём
 * перед меню воронки: выбор курса дают кнопки меню.
 */
export function instagramFaqFact(
  kind: InstagramFaq,
  language: ClientLanguage,
  p: PriceTable,
  t: Pick<SalesTexts, "certificateRuleRu" | "certificateRuleTg"> = DEFAULT_SALES_TEXTS,
): string {
  const c50 = p.price[COURSE_50];
  const c70 = p.price[COURSE_70];
  const tg = language === "tg";
  switch (kind) {
    case "duration":
      return tg
        ? "Курс ҳамеша дар шумо мемонад: як бор мехаред, дарсҳо нест намешаванд. Дарсҳоро дар Telegram-группа ё дар сайти мо мебинед, кадомаш ба шумо осон бошад."
        : "Курс остаётся у вас навсегда: покупаете один раз, уроки не удаляются. Смотреть можно в Telegram-группе или на нашем сайте, как вам удобнее.";
    case "length":
      return tg
        ? "Курс онлайн, дарсҳо видео ҳастанд, бо вақти худатон мебинед. Як бор мехаред, ҳамеша дар шумо мемонад."
        : "Курс онлайн, уроки в видео, смотрите в своём темпе. Покупаете один раз, и он остаётся у вас навсегда.";
    case "single_recipes":
      return tg
        ? `Рецептҳо алоҳида фурӯхта намешаванд, фақат курс пурра. 21 рецепт ${c70} сомонӣ, арт десерт ${c50} сомонӣ, ҳарду якҷоя ${p.bundle} сомонӣ.`
        : `Рецепты отдельно не продаются, только курс целиком. 21 рецепт за ${c70} сомони, арт-десерты за ${c50}, оба курса вместе за ${p.bundle}.`;
    case "certificate":
      return tg ? `Ҳа. ${t.certificateRuleTg}.` : `Да. ${t.certificateRuleRu}.`;
    case "about":
      return tg
        ? "Ин курсҳои муаллифии Ширин, кондитер аз Душанбе. Ду курси онлайн дорем ва як курси офлайн дар Душанбе."
        : "Это авторские курсы Ширин, кондитера из Душанбе. Есть два онлайн-курса и офлайн-курс в Душанбе.";
    case "talk":
      return tg
        ? "Ҳа, албатта, ман Ширин. Саволҳоятонро ҳамин ҷо нависед, ҷавоб медиҳам."
        : "Да, конечно, это Ширин. Пишите ваши вопросы здесь, я отвечу.";
  }
}

/** Лёгкий шаг дальше — только когда меню с кнопками НЕ уходит следом. */
function followUp(kind: InstagramFaq, tg: boolean): string {
  if (kind === "certificate") {
    return tg ? "Кадом курс ба шумо маъқул: онлайн ё офлайн дар Душанбе?" : "Вам интересен онлайн-курс или офлайн в Душанбе?";
  }
  return tg ? "Кадом курс ба шумо маъқул?" : "Какой курс вам интересен?";
}

/** Полный ответ без меню: суть и один лёгкий вопрос дальше, строкой ниже. */
export function instagramFaqAnswer(
  kind: InstagramFaq,
  language: ClientLanguage,
  p: PriceTable,
  t: Pick<SalesTexts, "certificateRuleRu" | "certificateRuleTg"> = DEFAULT_SALES_TEXTS,
): string {
  return `${instagramFaqFact(kind, language, p, t)}\n${followUp(kind, language === "tg")}`;
}
