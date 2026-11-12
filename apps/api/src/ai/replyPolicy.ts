import { stripServiceMarkers } from "./humanText.js";

/** Validate generated sales copy, never rewrite a customer's words or a recipe. */
export class ReplyPolicyError extends Error {
  readonly retryable = false;
  constructor(issues: string[]) {
    super(`Generated reply held: ${issues.join(", ")}`);
    this.name = "ReplyPolicyError";
  }
}

export function formalAddressIssues(text: string): string[] {
  return /(?:^|[^\p{L}])(?:ты|тебе|тебя|тобой|твой|твоя|твои|можешь|хочешь|напиши|открой|посмотри|ту|туро|туя)(?=$|[^\p{L}])/iu.test(
    text,
  )
    ? ["informal_address"]
    : [];
}

/**
 * Сумма, которую можно назвать ТОЛЬКО рядом со словами «вместо» / «по
 * отдельности» (сумма двух курсов, 05.09.2026: бот не говорит «за оба 120»,
 * но «100 вместо 120» — правда). В фактах она стоит в отдельном предложении с
 * этой меткой; в общий список разрешённых сумм не попадает.
 */
export const CONTEXT_ONLY_AMOUNT = "Только со словами «вместо» или «по отдельности»:";
const CONTEXT_WORDS = /(вместо|по\s+отдельност\p{L}*|отдельно|ба\s+ҷои|алоҳида)[^.!?\n]{0,25}$/iu;

/** Метка даты набора в фактах: «Дата набора офлайн-курса: 20 ноября» или «…: уточняется». */
export const COURSE_DATE_FACT = "Дата набора офлайн-курса:";
const MONTH_STEMS = [
  "январ",
  "феврал",
  "март",
  "апрел",
  "ма",
  "июн",
  "июл",
  "август",
  "сентябр",
  "октябр",
  "ноябр",
  "декабр",
];
const DAY_MONTH =
  /(?<!\d)([0-3]?\d)(?:-?(?:го|ум|юм|ом))?\s+(январ|феврал|март|апрел|ма[йяю]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*/giu;
const COURSE_CONTEXT = /курс|набор|офлайн|оффлайн|очн|заняти|начн|старт|оғоз|сабт|дарс|гурӯҳ|групп/iu;

function dayMonthKeys(text: string): string[] {
  return [...text.matchAll(DAY_MONTH)].map((m) => {
    const stem = m[2].toLowerCase();
    const month = stem !== "март" && stem.startsWith("ма") ? 5 : MONTH_STEMS.indexOf(stem) + 1;
    return `${Number(m[1])}.${month}`;
  });
}

/**
 * «УРОКИ ТОЛЬКО В TELEGRAM» — БОЛЬШЕ НЕ ПРАВДА (владелец 11.11.2026). Уроки есть и
 * на нашем сайте; «бе телеграм намешад» отпугивало тех, у кого Telegram нет.
 * Запрет стоит дважды: в промпте (deliveryContext.ts) и здесь, перед отправкой.
 */
const TELEGRAM_ONLY =
  /(факат|фақат|танхо|танҳо|только|лишь)\s+(да\s+|дар\s+|в\s+)?(телеграм\p{L}*|telegram)|бе\s+телеграм\p{L}*\s+(намеш\p{L}*|нашав\p{L}*|намешад|не)|без\s+телеграм\p{L}*[^.!?\n]{0,20}(нельзя|не\s+получится|не\s+выйдет|никак)|(дар|да)\s+(ватсап|вацап|whatsapp)\p{L}*\s+(намеш\p{L}*|рои\s+намекун\p{L}*|сифат\p{L}*\s+вайрон)/iu;

export function telegramOnlyIssues(text: string): string[] {
  return TELEGRAM_ONLY.test(text) ? ["telegram_only_claim"] : [];
}

/**
 * ВЫДУМКИ, КОТОРЫЕ УЖЕ БЫЛИ (разбор переписок 11.11.2026). Фактов об этом у бота
 * нет, а сказанное стоило клиентов: «сертификат сам появится в программе»,
 * «скачать можно / нельзя», «из Казахстана можно перевести» (потом «карты нет»),
 * «ссылка в течение часа», «простые печи не подходят» (факт — только про Odul).
 * Такой ответ перегенерируется, а не уходит; повторилось — «Ширин ответит»
 * (ai.ts::handOffUnknownToShirin).
 */
const UNVERIFIED_CLAIMS: RegExp[] = [
  /сертификат[^.!?\n]{0,60}(в\s+программ\p{L}*|в\s+приложени\p{L}*|сам\p{L}*\s+(появ|прид|выда)\p{L}*|дар\s+барнома|худаш\s+(мебаро|меоя|пайдо)\p{L}*)/iu,
  /(скача\p{L}*|скачив\p{L}*|загрузить\s+(себе|на\s+телефон)|сохранить\s+(видео|урок)\p{L}*\s+(на|в)\s+(телефон|галере)\p{L}*|боргир\p{L}*|download)/iu,
  /(казахстан\p{L}*|қазоқистон|казокистон|kaspi|каспи|узбекистан\p{L}*|ўзбекистон|кыргызстан\p{L}*|киргиз\p{L}*)/iu,
  /(в\s+течение\s+(часа|\d+\s*(минут|час)\p{L}*)|через\s+(час|\d+\s*(минут|час)\p{L}*)|дар\s+(як|давоми\s+як|\d+)\s+соат|баъди\s+(як|\d+)\s+соат|дар\s+\d+\s+дакика)/iu,
  /(прост\p{L}*|обычн\p{L}*|одди\p{L}*|оддӣ)\s+(печ\p{L}*|духовк\p{L}*|танур\p{L}*|духовка)[^.!?\n]{0,40}(не\s+подход\p{L}*|намеш\p{L}*|намешад|мувофик\s+нест|нашояд|не\s+годят\p{L}*)/iu,
];

export function unverifiedClaimIssues(text: string): string[] {
  return UNVERIFIED_CLAIMS.some((re) => re.test(text)) ? ["unverified_claim"] : [];
}

/** Модель сама сказала «фактов нет — пусть ответит Ширин» (правило 30 в prompts.ts). */
export const ASK_SHIRIN = "[ASK_SHIRIN]";
export function isAskShirin(text: string | null | undefined): boolean {
  return (text ?? "").includes(ASK_SHIRIN);
}

export function replyPolicyIssues(text: string, trustedFacts: string): string[] {
  const issues: string[] = [...formalAddressIssues(text), ...telegramOnlyIssues(text), ...unverifiedClaimIssues(text)];
  const amounts = /(\d+(?:[.,]\d+)?)\s*(сомон[иӣ]?|с\.|TJS|руб(?:лей)?|доллар(?:ов)?|USD|€|\$)/giu;
  const currency = (value: string) =>
    /^(сомон|с\.|TJS)/iu.test(value)
      ? "TJS"
      : /^(доллар|USD|\$)/iu.test(value)
        ? "USD"
        : /^руб/iu.test(value)
          ? "RUB"
          : "EUR";
  const amountKey = (match: RegExpMatchArray) => `${match[1].replace(",", ".")}:${currency(match[2])}`;
  const sentences = trustedFacts.split(/(?<=\.)\s+/);
  const contextFacts = sentences.filter((s) => s.includes(CONTEXT_ONLY_AMOUNT)).join(" ");
  const plainFacts = sentences.filter((s) => !s.includes(CONTEXT_ONLY_AMOUNT)).join(" ");
  const allowed = new Set([...plainFacts.matchAll(amounts)].map(amountKey));
  const contextOnly = new Set([...contextFacts.matchAll(amounts)].map(amountKey));
  // Only financial claims, not harmless recipe quantities, dates or list numbers.
  for (const match of text.matchAll(amounts)) {
    const key = amountKey(match);
    if (allowed.has(key)) continue;
    if (contextOnly.has(key) && CONTEXT_WORDS.test(text.slice(Math.max(0, (match.index ?? 0) - 40), match.index)))
      continue;
    issues.push("unverified_amount");
  }
  // Дата набора — только та, что в «Цены и даты» (или никакой, если «уточняется»).
  // Проверяется лишь в предложениях про курс: «чек от 5 ноября» не трогаем.
  const dateFact = sentences.find((s) => s.includes(COURSE_DATE_FACT));
  if (dateFact) {
    const allowedDates = new Set(dayMonthKeys(dateFact));
    for (const sentence of text.split(/(?<=[.!?\n])/)) {
      if (!COURSE_CONTEXT.test(sentence)) continue;
      if (dayMonthKeys(sentence).some((d) => !allowedDates.has(d))) issues.push("wrong_course_date");
    }
  }
  // A valid price for a different course is still an incorrect claim.
  for (const label of ["арт[ -]десерт[ыов]*", "21\\s*(?:рецепт|дастур)", "(?:оба курса|ҳар ду курс|комплект)"]) {
    const claim = new RegExp(`${label}[^.!?;\\n]{0,45}?(\\d+(?:[.,]\\d+)?)\\s*(?:сомон[иӣ]?|с\\.|TJS)`, "giu");
    const known = new RegExp(claim.source, "iu").exec(trustedFacts)?.[1];
    if (known) for (const match of text.matchAll(claim)) if (match[1] !== known) issues.push("wrong_course_price");
  }
  const compactFacts = trustedFacts.replace(/[\s()+-]/g, "");
  for (const match of text.matchAll(/(?<!\d)(?:\+?992[\s()-]*)?\d{3}[\s()-]*\d{3}[\s()-]*\d{3}(?!\d)/g)) {
    const digits = match[0].replace(/[\s()+-]/g, "");
    const local = digits.length === 12 && digits.startsWith("992") ? digits.slice(3) : digits;
    if (!compactFacts.includes(local)) issues.push("unverified_phone");
  }
  return [...new Set(issues)];
}

/** Recipe quantities are deliberately outside this check. */
export function guardGeneratedTone(text: string | null): string | null {
  if (!text || formalAddressIssues(text).length) return null;
  return cleanGeneratedReply(text) || null;
}

/**
 * Чистка ОТВЕТА МОДЕЛИ перед отправкой: служебные метки ([ASK_SHIRIN], [NO_REPLY],
 * humanText.ts::SERVICE_MARKERS) плюс общая чистка. Тексты воронки и шаблоны
 * владельца сюда не идут — в них метки не режем (повторное ревью 11.11.2026).
 */
export function cleanGeneratedReply(text: string): string {
  return cleanAutomatedReply(stripServiceMarkers(text));
}

export const FORMAL_TONE_RULE = "Обращайтесь только на «вы» по-русски и «шумо» по-таджикски. Без эмодзи.";

/**
 * «Линк» по-таджикски клиенты не понимают (владелец 12.11.2026): говорят «ссылка»,
 * иногда «дар сайти мо» / «сомонаи мо». Модели это сказано в REPLY_POLICY_INSTRUCTION,
 * а если слово всё же проскочило — меняем на «ссылка» с тем же окончанием
 * (линкро → ссылкаро, линки → ссылкаи). Ручные ответы Ширин сюда не идут.
 */
const LINK_WORD = /(?<!\p{L})([Лл])инк(ҳо|хо|ро|и|ам|ат|аш|амон|атон|ашон)?(?!\p{L})/gu;
export function replaceLinkWord(text: string): string {
  return text.replace(LINK_WORD, (_m, l: string, suffix = "") => `${l === "Л" ? "С" : "с"}сылка${suffix}`);
}

export function cleanAutomatedReply(text: string): string {
  // A single policy for generated text and automatic templates; human sends bypass it.
  return replaceLinkWord(text)
    .replace(
      /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu,
      "",
    )
    .trim();
}

/** Разрешённые тёплые завершающие смайлики (voice.ts::maybeWarmEmoji, ai/reactions.ts). */
const WARM_TAIL = /\s(❤️|🌸|💚|🤍|🥰|😊|✨|🌷)$/u;

/**
 * Общая чистка от смайликов, но ОДИН тёплый смайлик в самом конце остаётся: без этого
 * решение владельца «редко ставить ❤️ или 🌸, как Ширин» не доходило до клиента (send.ts
 * срезал всё), а в историю писалось не то, что ушло (ревью 08.11.2026).
 */
export function cleanKeepingWarmTail(text: string): string {
  const tail = WARM_TAIL.exec(text.trim());
  const cleaned = cleanAutomatedReply(text);
  return tail && cleaned ? `${cleaned} ${tail[1]}` : cleaned;
}

export const REPLY_POLICY_INSTRUCTION =
  "\nОбращайтесь к клиенту только на «вы» по-русски и «шумо» по-таджикски. Смайлики сами не ставьте: когда уместно, их добавляет система. Не называйте неподтверждённые суммы или номера телефона. Если ответа не требуется по правилам, верните ровно [NO_REPLY], не пустой ответ. Если ответа нет в фактах выше, верните ровно [ASK_SHIRIN], не угадывайте. По-таджикски не пишите «линк»: говорите «ссылка» или «дар сайти мо» / «дар сомонаи мо», чередуйте.";
