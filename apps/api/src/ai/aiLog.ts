import { prisma, logError } from "../db.js";
import { estimateCostUsd, type TokenUsage } from "./pricing.js";

/**
 * Запись одного вызова Gemini в журнал — endpoint свой у каждого места
 * (ai-reply, comment-reply, receipt-check, voice-to-text, nightly-learning),
 * чтобы разбор "куда уходят деньги" не сводился к одной непонятной сумме.
 *
 * Журнал не должен ронять то, что он записывает: ошибка записи только логируется.
 */
export async function logAiCall(params: {
  endpoint: string;
  model?: string;
  usage?: TokenUsage;
  ms: number;
  ok: boolean;
}): Promise<void> {
  const { endpoint, model, usage, ms, ok } = params;
  try {
    await prisma.aiLog.create({
      data: {
        endpoint,
        model: model ?? null,
        inputTokens: usage?.inputTokens || null,
        outputTokens: usage?.outputTokens || null,
        cacheReadTokens: usage?.cacheReadTokens || null,
        costUsd: model && usage ? estimateCostUsd(model, usage) : null,
        ms,
        ok,
      },
    });
  } catch (err) {
    logError("aiLog", err);
  }
}
