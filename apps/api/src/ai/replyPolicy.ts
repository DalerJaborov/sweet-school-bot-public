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

export function replyPolicyIssues(text: string, trustedFacts: string): string[] {
  const issues: string[] = formalAddressIssues(text);
  const amounts = /(\d+(?:[.,]\d+)?)\s*(сомон[иӣ]?|с\.|TJS|руб(?:лей)?|доллар(?:ов)?|USD|€|\$)/giu;
  const currency = (value: string) => /^(сомон|с\.|TJS)/iu.test(value) ? "TJS" : /^(доллар|USD|\$)/iu.test(value) ? "USD" : /^руб/iu.test(value) ? "RUB" : "EUR";
  const amountKey = (match: RegExpMatchArray) => `${match[1].replace(",", ".")}:${currency(match[2])}`;
  const allowed = new Set([...trustedFacts.matchAll(amounts)].map(amountKey));
  // Only financial claims, not harmless recipe quantities, dates or list numbers.
  for (const match of text.matchAll(amounts)) {
    if (!allowed.has(amountKey(match))) issues.push("unverified_amount");
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
