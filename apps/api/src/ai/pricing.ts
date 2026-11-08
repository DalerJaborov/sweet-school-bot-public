/**
 * Цены на модели Gemini — доллары за миллион токенов.
 *
 * Те же цифры, что в основной CRM (royal-home-crm/apps/api/src/ai/pricing.ts) —
 * это тот же провайдер и часто те же модели. Сверено со справочником
 * поставщика 26.07.2026 (там же, где сверяла CRM). При смене цен правится
 * только эта таблица; пересчитать старые записи можно по полю AiLog.model.
 *
 * Кэш Google тарифицирует иначе (за хранение), мы его не пишем — только
 * читаем, поэтому здесь нет отдельной ставки записи, как в CRM.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const PER_MILLION: Record<string, ModelPrice> = {
  // СВЕРЕНО 08.11.2026 с официальной страницей цен Google (aistudio.google.com/docs/pricing,
  // платный тариф, стандарт). Прежние ставки 0.3/2.5 для 3.6-flash были занижены в 2,5 раза.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.1875 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cacheRead: 0.1875 },
  // gemini-3.7-flash отвечает на проде, но на странице цен её НЕТ: берём ставку соседней 3.6 (ОЦЕНКА).
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cacheRead: 0.1875 },
  // gemini-3.5-flash тоже не указана отдельно — как 3.6 (ОЦЕНКА).
  "gemini-3.5-flash": { input: 0.75, output: 3.75, cacheRead: 0.1875 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.125 },
  // Дешёвые flash-lite — шлюз «не по делу» и расшифровка голоса (ai/relevanceGate.ts).
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.0625 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.5 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Стоимость вызова в долларах. null — цены для модели нет: врать нулём нельзя,
 * ноль в отчёте читается как «бесплатно», а не как «неизвестно».
 */
export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number | null {
  const price = model ? PER_MILLION[model] : undefined;
  if (!price) return null;

  const cost =
    (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead) /
    1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
