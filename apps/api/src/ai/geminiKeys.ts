import { getSetting } from "../db.js";

/**
 * Основной ключ Gemini плюс сколько угодно запасных из «Ещё ключи Gemini» —
 * один на строку (или через запятую). Разные ключи почти всегда живут в разных
 * проектах Google, а суточная квота считается НА ПРОЕКТ, а не на ключ — так что
 * несколько ключей страхуют не только от отказа одного ключа, но и от того, что
 * школьный бот выест общую квоту вместе с основной CRM (если ключи разных
 * проектов).
 */
export async function resolveGeminiKeys(): Promise<string[]> {
  const primary = (await getSetting("geminiKey"))?.trim();
  const extraRaw = (await getSetting("geminiKeysExtra")) ?? "";
  const extra = extraRaw
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter(Boolean);

  const all = [primary, ...extra].filter((k): k is string => !!k);
  return [...new Set(all)];
}
