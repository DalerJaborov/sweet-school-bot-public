/** Validate generated sales copy, never rewrite a customer's words or a recipe. */
export class ReplyPolicyError extends Error {
  readonly retryable = false;
  constructor(issues: string[]) {
    super(`Generated reply held: ${issues.join(", ")}`);
    this.name = "ReplyPolicyError";
  }
}

export function formalAddressIssues(text: string): string[] {
  return /(?:^|[^\p{L}])(?:ты|тебе|тебя|тобой|твой|твоя|твои|можешь|хочешь|напиши|открой|посмотри|ту|туро|туя)(?=$|[^\p{L}])/iu.test(text) ? ["informal_address"] : [];
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
const MONTH_STEMS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const DAY_MONTH = /(?<!\d)([0-3]?\d)(?:-?(?:го|ум|юм|ом))?\s+(январ|феврал|март|апрел|ма[йяю]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*/giu;
const COURSE_CONTEXT = /курс|набор|офлайн|оффлайн|очн|заняти|начн|старт|оғоз|сабт|дарс|гурӯҳ|групп/iu;

function dayMonthKeys(text: string): string[] {
  return [...text.matchAll(DAY_MONTH)].map((m) => {
    const stem = m[2].toLowerCase();
    const month = stem !== "март" && stem.startsWith("ма") ? 5 : MONTH_STEMS.indexOf(stem) + 1;
    return `${Number(m[1])}.${month}`;
  });
}

export function replyPolicyIssues(text: string, trustedFacts: string): string[] {
  const issues: string[] = formalAddressIssues(text);
  const amounts = /(\d+(?:[.,]\d+)?)\s*(сомон[иӣ]?|с\.|TJS|руб(?:лей)?|доллар(?:ов)?|USD|€|\$)/giu;
  const currency = (value: string) => /^(сомон|с\.|TJS)/iu.test(value) ? "TJS" : /^(доллар|USD|\$)/iu.test(value) ? "USD" : /^руб/iu.test(value) ? "RUB" : "EUR";
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
    if (contextOnly.has(key) && CONTEXT_WORDS.test(text.slice(Math.max(0, (match.index ?? 0) - 40), match.index))) continue;
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
  return cleanAutomatedReply(text) || null;
}

export const FORMAL_TONE_RULE = "Обращайтесь только на «вы» по-русски и «шумо» по-таджикски. Без эмодзи.";

export function cleanAutomatedReply(text: string): string {
  // A single policy for generated text and automatic templates; human sends bypass it.
  return text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu, "").trim();
}

export const REPLY_POLICY_INSTRUCTION = "\nОбращайтесь к клиенту только на «вы» по-русски и «шумо» по-таджикски. Без эмодзи. Не называйте неподтверждённые суммы или номера телефона. Если ответа не требуется по правилам, верните ровно [NO_REPLY], не пустой ответ.";
