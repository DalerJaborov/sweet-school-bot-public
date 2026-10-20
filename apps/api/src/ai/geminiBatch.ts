import { geminiUrl, geminiProxyHeaders } from "../gemini.js";

/**
 * ПАКЕТНЫЙ РЕЖИМ GEMINI (Batch API) — скидка 50% на все токены в обмен на
 * ожидание до 24 часов. Для задач, которых никто не ждёт в моменте: ночное
 * обучение манере продаж (nightlyLearning.ts) — первый и пока единственный
 * потребитель.
 *
 * Формат создания и опроса проверен живым запросом на боевом ключе 30.08.2026;
 * поле результата (inlinedResponses) — по документации ai.google.dev/gemini-api/
 * docs/batch-api. На форуме Google есть жалобы, что готовые задания иногда не
 * отдаются (503 на batches.get при SUCCEEDED) — поэтому у потребителя ОБЯЗАН
 * быть фоллбек на обычный синхронный вызов: batch — скидка, а не точка отказа.
 */

/**
 * ГРАБЛЯ ПРОКСИ: на GET-запросах Cloudflare Worker теряет заголовок
 * x-goog-api-key (Google отвечает 403 «unregistered callers»), хотя на POST
 * доносит его исправно. Найдено живой проверкой 30.08.2026. Обход — ключ
 * query-параметром ?key= (Google принимает оба способа), заголовок прокси
 * x-proxy-key при этом остаётся обязательным.
 */
function batchGetUrl(name: string, apiKey: string): string {
  return geminiUrl(`/v1beta/${name}?key=${encodeURIComponent(apiKey)}`);
}

export interface BatchSubmitOk {
  /** Имя задания у Google: "batches/…" — им же опрашивается статус. */
  name: string;
}

/** Создаёт пакетное задание с одним запросом generateContent. null — создать не
 *  вышло (сеть, отказ Google): вызывающий идёт обычным синхронным путём. */
export async function submitGeminiBatch(params: {
  apiKey: string;
  model: string;
  displayName: string;
  /** Тело одного GenerateContentRequest: contents + generationConfig и т.п. */
  request: Record<string, unknown>;
}): Promise<BatchSubmitOk | null> {
  try {
    const res = await fetch(geminiUrl(`/v1beta/models/${params.model}:batchGenerateContent`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": params.apiKey, ...geminiProxyHeaders() },
      body: JSON.stringify({
        batch: {
          display_name: params.displayName,
          input_config: { requests: { requests: [{ request: params.request, metadata: { key: "r1" } }] } },
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string };
    return data.name ? { name: data.name } : null;
  } catch {
    return null;
  }
}

export type BatchPoll =
  | { status: "pending" }
  | { status: "done"; text: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
  | { status: "failed"; detail: string };

/**
 * Один опрос задания. "pending" — ещё считается, зайдите позже; "done" — текст
 * первого ответа готов; "failed" — задание умерло (или результат невозможно
 * достать), вызывающему пора на синхронный фоллбек.
 */
export async function pollGeminiBatch(apiKey: string, name: string): Promise<BatchPoll> {
  try {
    const res = await fetch(batchGetUrl(name, apiKey), { method: "GET", headers: { ...geminiProxyHeaders() } });
    if (!res.ok) return { status: "failed", detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    type InlinedItem = {
      response?: {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
      };
      error?: { message?: string };
    };
    const data = (await res.json()) as {
      metadata?: { state?: string };
      response?: { inlinedResponses?: InlinedItem[] | { inlinedResponses?: InlinedItem[] } };
      error?: { message?: string };
    };
    const state = data.metadata?.state ?? "";
    if (state === "BATCH_STATE_PENDING" || state === "BATCH_STATE_RUNNING") return { status: "pending" };
    if (state !== "BATCH_STATE_SUCCEEDED") {
      return { status: "failed", detail: data.error?.message ?? `state=${state || "нет"}` };
    }
    // Документация показывает inlinedResponses то массивом, то объектом с
    // внутренним массивом — принимаем обе формы, живой формат закрепит ночь.
    const raw = data.response?.inlinedResponses;
    const list = Array.isArray(raw) ? raw : raw?.inlinedResponses;
    const first = list?.[0];
    if (!first?.response) return { status: "failed", detail: first?.error?.message ?? "SUCCEEDED, но ответа нет" };
    const text = (first.response.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) return { status: "failed", detail: "SUCCEEDED, но текст пуст" };
    const u = first.response.usageMetadata;
    return {
      status: "done",
      text,
      usage: {
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: u?.candidatesTokenCount ?? 0,
        cacheReadTokens: u?.cachedContentTokenCount ?? 0,
      },
    };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
