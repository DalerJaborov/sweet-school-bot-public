import { env } from "./env.js";

/**
 * Как бот вообще дозванивается до Gemini — адрес, прокси, повторы.
 *
 * ГЕОБЛОК. Регион VPS не поддерживается Gemini API напрямую ("User location is not
 * supported for the API use") — та же история, что была с graph.instagram.com. Тот
 * же Cloudflare Worker (см. instagram.ts), у него есть маршрут /gemini/* — через него
 * и ходим, когда прокси настроен.
 */
const GEMINI_HOST = "https://generativelanguage.googleapis.com";

export function geminiUrl(path: string): string {
  return env.igProxyBase ? `${env.igProxyBase.replace(/\/+$/, "")}/gemini${path}` : `${GEMINI_HOST}${path}`;
}

export function geminiProxyHeaders(): Record<string, string> {
  return env.igProxyKey ? { "x-proxy-key": env.igProxyKey } : {};
}

export function geminiGenerateUrl(model: string): string {
  return geminiUrl(`/v1beta/models/${model}:generateContent`);
}

/** Google возвращает адрес заливки File API своим хостом — с геоблоком его нужно
 *  переписать обратно на прокси, иначе заливка уйдёт мимо него и упрётся в блок. */
export function throughProxy(url: string): string {
  if (!env.igProxyBase) return url;
  try {
    const parsed = new URL(url);
    if (parsed.host !== "generativelanguage.googleapis.com") return url;
    return `${env.igProxyBase.replace(/\/+$/, "")}/gemini${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Модели линейки 3.x, которые НЕ принимают самый нижний уровень размышления.
 * У них минимально допустимый — "low", а на "minimal" приходит 400 «Thinking
 * level MINIMAL is not supported for this model».
 *
 * Список перенесён из основной CRM (ai/geminiTransport.ts) — тот же провайдер,
 * те же модели, и там это уже стоило целого дня (17-18.08.2026): основная
 * модель `gemini-3.7-flash` отвечала 400 на КАЖДЫЙ вызов с `thinkingLevel:
 * "minimal"`, перебор уходил на резервную и писал в журнал «основная
 * недоступна», хотя модель была доступна всё это время. Список моделей,
 * которые ПРИНИМАЮТ "minimal" (3-flash-preview, 3.1, 3.5, 3.6), проверен
 * там же на боевом ключе — незачем повторять ту же проверку заново здесь и
 * рисковать той же ошибкой на своём трафике.
 */
const MINIMAL_THINKING_UNSUPPORTED = [/^gemini-3\.7-/];

/** «Размышление» съедает лимит ответа и тарифицируется как output по полной
 *  цене — глушим его до минимума, какой принимает конкретная модель. */
export function thinkingConfigFor(model: string): Record<string, unknown> {
  if (/^gemini-2\./.test(model)) return { thinkingBudget: 0 };
  const level = MINIMAL_THINKING_UNSUPPORTED.some((re) => re.test(model)) ? "low" : "minimal";
  return { thinkingLevel: level };
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000];

export function isRetryableStatus(status: number): boolean {
  return status === 503 || status === 429 || status === 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Резервные модели — пробуем по очереди, если основная перегружена (503/429) или
 * недоступна (500). Все проверены на проде CRM 18.08.2026 с тем же thinkingConfig,
 * что здесь (`low`) — ни одна не даёт 400 на этот параметр, поэтому список общий,
 * без разбора по семействам, как в основной CRM.
 */
export const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash", "gemini-3-flash-preview"];

/** Токены израсходованного ответа — по ним считаются деньги (см. ai/pricing.ts). */
export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Вызов инструмента, который попросила модель (tool-calling, assistantPanel.ts).
 *  Присутствует только когда в запросе были `tools.functionDeclarations`. */
export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  /** Gemini 3 требует вернуть подпись рассуждения вместе с вызовом в следующем ходе — иначе HTTP 400. */
  thoughtSignature?: string;
}

/** Модель, которая реально ответила (не обязательно primaryModel — могла
 *  сработать резервная) — без неё цену вызова посчитать не по чему. */
type GeminiResult = { text: string | null; model: string; usage: GeminiUsage; functionCalls?: GeminiFunctionCall[] } | { error: string };

function parseUsage(u?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }): GeminiUsage {
  return {
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
    cacheReadTokens: u?.cachedContentTokenCount ?? 0,
  };
}

/**
 * Зовёт Gemini с переданным телом запроса (contents/system_instruction уже собраны
 * вызывающим), перебирая ключи, а внутри каждого ключа — модели из FALLBACK_MODELS.
 * Ключ снаружи, модель внутри — тот же порядок, что в основной CRM: если ключ
 * отклонён целиком (401/403 — не тот проект, кончилась квота, деактивирован),
 * следующая модель ТЕМ ЖЕ ключом ничего не даст, сразу переходим к следующему
 * ключу. Внутри одной пары ключ+модель — до 3 повторов на 503/429/500. Один общий
 * дедлайн на весь перебор — иначе клиент ждёт ответа кругами по несколько минут.
 */
export async function generateWithFallback(
  apiKeys: string[],
  primaryModel: string,
  buildBody: (model: string) => string,
  totalBudgetMs: number
): Promise<GeminiResult> {
  const deadline = Date.now() + totalBudgetMs;
  const models = [primaryModel, ...FALLBACK_MODELS.filter((m) => m !== primaryModel)];
  let lastDetail = "нет ответа";

  keys: for (const apiKey of apiKeys) {
    for (const model of models) {
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
        const left = deadline - Date.now();
        // Речь о ВРЕМЕНИ на этот один запрос, а не о деньгах и не о квоте Google.
        // Прежняя формулировка «бюджет исчерпан» читалась как «кончились деньги».
        if (left <= 0) return { error: `вышло отведённое время на ответ; последняя причина: ${lastDetail}` };
        if (attempt > 0) await sleep(Math.min(RETRY_DELAYS_MS[attempt - 1], left));

        try {
          const res = await fetch(geminiGenerateUrl(model), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
            body: buildBody(model),
            signal: AbortSignal.timeout(Math.min(45_000, Math.max(1000, deadline - Date.now()))),
          });
          if (!res.ok) {
            lastDetail = `Gemini (${model}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
            if (res.status === 401 || res.status === 403) continue keys; // ключ целиком плохой
            if (!isRetryableStatus(res.status)) break; // следующая модель, тот же ключ
            continue; // повтор той же модели
          }
          const data = (await res.json()) as {
            candidates?: {
              content?: {
                parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }[];
              };
              finishReason?: string;
            }[];
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              cachedContentTokenCount?: number;
            };
          };
          const candidate = data.candidates?.[0];
          const usage = parseUsage(data.usageMetadata);
          // Части с флагом thought:true — черновик размышления, не ответ; API
          // отдаёт их отдельно от финального текста, когда явно просит вернуть
          // и то, и другое. У нас такого запроса нет, но фильтр не помешает.
          const text =
            candidate?.content?.parts
              ?.filter((p) => !p.thought)
              .map((p) => p.text ?? "")
              .join("")
              .trim() ?? "";

          /**
           * ОБРЕЗАНО ЛИМИТОМ ТОКЕНОВ — НЕ ОТДАЁМ КАК ОТВЕТ (найдено 22.08.2026
           * живьём: клиент получил «Drafting the Response:**...», оборванное на
           * полуслове). Причина — не утечка отдельной «мысли» в текст (для
           * gemini-3.x она приходит непрозрачной подписью thoughtSignature,
           * не читаемым текстом), а то, что thinkingLevel:"low" на живом
           * прогоне съел 287 из 300 токенов бюджета — на сам ответ осталось
           * 9-13, и модель обрывается финишем MAX_TOKENS, иногда прямо
           * посреди служебной разметки. Раньше это молча уходило клиенту как
           * «успешный» ответ. Теперь такой результат — не успех: пробуем ещё
           * раз (тот же цикл retry/следующая модель ниже); если ВСЕ попытки
           * упрутся в тот же лимит, вызывающий получит {error}, а не текст —
           * тишина безопаснее оборванной фразы (тот же принцип, что и молчание
           * на нераспознанное вложение).
           */
          if (candidate?.finishReason === "MAX_TOKENS") {
            lastDetail = `Gemini (${model}): ответ обрезан лимитом токенов (размышление съело бюджет)`;
            continue;
          }
          // Просьбы вызвать инструмент — отдельными частями; без объявленных
          // инструментов их не бывает, и список остаётся пустым.
          const functionCalls: GeminiFunctionCall[] = (candidate?.content?.parts ?? [])
            .filter((p) => p.functionCall?.name)
            .map((p) => ({
              name: p.functionCall!.name!,
              args: p.functionCall!.args ?? {},
              ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
            }));
          return { text: text || null, model, usage, ...(functionCalls.length > 0 ? { functionCalls } : {}) };
        } catch (err) {
          lastDetail = `Gemini (${model}): ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  return { error: lastDetail };
}
