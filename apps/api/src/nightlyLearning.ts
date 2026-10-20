import { prisma, getSetting, setSetting, logError } from "./db.js";
import { generateWithFallback, thinkingConfigFor } from "./gemini.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { mergeObjectionEntries, type NewObjection } from "./ai/objectionLibrary.js";
import { logAiCall } from "./ai/aiLog.js";
import { pollGeminiBatch, submitGeminiBatch } from "./ai/geminiBatch.js";

/**
 * НОЧНОЙ РАЗБОР ДНЯ — бот учится не только манере, но и продаже.
 *
 * Живые примеры (styleLearning.ts) дают ТОН: как Ширин пишет. Но они не
 * объясняют, ПОЧЕМУ одни разговоры кончаются оплатой, а другие — тишиной. Раз в
 * сутки, ночью, модель в роли маркетолога и психолога читает разговоры дня —
 * отдельно те, что закончились покупкой, и отдельно те, где человек пропал, —
 * и выписывает конкретные приёмы: какие слова работают, где люди отваливаются,
 * что сказать в такой момент.
 *
 * ПРОМТ ВЛАДЕЛЬЦА НЕ ТРОГАЕТСЯ НИКОГДА. Результат ложится в отдельную настройку
 * `salesInsights` и подмешивается к промту как приложение — владелец видит его
 * в панели и может стереть одной кнопкой, а его собственные правила остаются
 * ровно такими, какими он их написал.
 *
 * ТОТ ЖЕ ночной вызов заодно вытаскивает пары «возражение → сработавший ответ»
 * (только из разговоров, реально закончившихся оплатой) и копит их отдельно, в
 * `objectionLibrary` (см. ai/objectionLibrary.ts) — растущую, дедуплицированную
 * библиотеку, а не однодневную заметку поверх salesInsights.
 */

const RUN_HOUR = 3; // ночь по Душанбе: людей нет, спешить некуда
const DEFAULT_OFFSET_HOURS = 5;
const BUDGET_MS = 120_000;
const MAX_DIALOGS = 12;
const MAX_MESSAGES_PER_DIALOG = 24;
const SENT_KEY = "salesInsightsDay";
export const INSIGHTS_KEY = "salesInsights";

type Dialog = { who: string; sold: boolean; lines: string[] };

async function collectDialogs(from: Date, to: Date): Promise<Dialog[]> {
  // Кто вообще писал за сутки — по ним и разбираем; тех, кто купил, берём в
  // первую очередь: удачных разговоров всегда меньше, и они ценнее.
  const contacts = await prisma.contact.findMany({
    where: { messages: { some: { createdAt: { gte: from, lt: to } } }, personal: false },
    orderBy: [{ paid: "desc" }, { updatedAt: "desc" }],
    take: MAX_DIALOGS,
    select: { id: true, username: true, igUserId: true, paid: true, paidAt: true },
  });

  const out: Dialog[] = [];
  for (const c of contacts) {
    const messages = await prisma.message.findMany({
      where: { contactId: c.id, createdAt: { gte: from, lt: to }, text: { not: null } },
      orderBy: { createdAt: "asc" },
      take: MAX_MESSAGES_PER_DIALOG,
      select: { direction: true, text: true },
    });
    if (messages.length < 2) continue; // из одного сообщения выводов не сделать
    out.push({
      who: c.username ?? c.igUserId,
      sold: Boolean(c.paid && c.paidAt && c.paidAt >= from),
      lines: messages.map((m) => `${m.direction === "IN" ? "Клиент" : "Школа"}: ${(m.text ?? "").slice(0, 300)}`),
    });
  }
  return out;
}

function buildPrompt(dialogs: Dialog[]): string {
  const sold = dialogs.filter((d) => d.sold);
  const lost = dialogs.filter((d) => !d.sold);
  const render = (list: Dialog[]) =>
    list.map((d, i) => `— Разговор ${i + 1} (${d.who}) —\n${d.lines.join("\n")}`).join("\n\n");

  return (
    "Ты — маркетолог и психолог продаж. Перед тобой переписки за сутки из директа " +
    "авторского кондитерского курса Ширин в Душанбе. Продают два онлайн-курса (50 и 70 сомони, оба вместе — 100) и офлайн-курс. " +
    "Отвечает администратор — женщина, пишет на душанбинском разговорном таджикском.\n\n" +
    `РАЗГОВОРЫ С ПОКУПКОЙ (${sold.length}):\n${sold.length ? render(sold) : "сегодня таких не было"}\n\n` +
    `РАЗГОВОРЫ БЕЗ ПОКУПКИ (${lost.length}):\n${lost.length ? render(lost) : "нет"}\n\n` +
    "ЗАДАЧА 1 — общие наблюдения. Выпиши КОНКРЕТНЫЕ вещи, которые сделают ответы завтра лучше. " +
    "Не общие советы («будьте вежливы»), а именно то, что видно в этих переписках: " +
    "какие слова и обороты приводили к оплате; на каком именно вопросе человек замолкал; " +
    "что администратор ответила поздно или не ответила; какое возражение повторяется. " +
    "Если разговоров с покупкой не было — разбирай, где именно терялись люди. " +
    "Не больше 6 пунктов, каждый — одна строка, начинается с «— »; пиши по-русски, но примеры фраз оставляй как " +
    "есть, на таджикском; ничего не выдумывай — если данных мало, пунктов меньше.\n\n" +
    "ЗАДАЧА 2 — библиотека возражений. Только в РАЗГОВОРАХ С ПОКУПКОЙ (не трогай разговоры без оплаты — там " +
    "неизвестно, сработал бы ответ или нет) найди места, где клиент явно возразил или засомневался (по цене, " +
    "спросил разрешения у мужа/семьи, не поверил, что это не развод/обман, сравнил с конкурентами, тянул время — " +
    "«подумаю»), а администратор что-то ответила, и разговор ВСЁ РАВНО дошёл до оплаты. Для каждого такого случая " +
    "выпиши: тип возражения строго одним словом из списка [\"цена\", \"муж\", \"недоверие\", \"конкуренты\", " +
    "\"откладывает\", \"другое\"]; дословную (или очень близкую к дословной) цитату клиента; дословный ответ " +
    "администратора, который сработал. НЕ ВЫДУМЫВАЙ и не бери гипотетические ответы — только то, что реально " +
    "написано в переписке и реально привело к оплате. Если таких случаев не было — пустой список.\n\n" +
    "Ответь СТРОГО одним JSON-объектом, без пояснений и без markdown-обрамления, ровно такой формы:\n" +
    '{"insights": ["— …", "— …"], "objections": [{"type": "цена", "customerQuote": "…", "counterThatWorked": "…"}]}'
  );
}

type NightlyResult = { insights: string[]; objections: NewObjection[] };

const VALID_OBJECTION_TYPES = new Set(["цена", "муж", "недоверие", "конкуренты", "откладывает", "другое"]);

function parseNightlyResult(raw: string): NightlyResult | null {
  const cleaned = raw.replace(/^```json\s*|^```\s*|```\s*$/gim, "").trim();
  try {
    const data = JSON.parse(cleaned) as { insights?: unknown; objections?: unknown };
    const insights = Array.isArray(data.insights)
      ? data.insights.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const objections = Array.isArray(data.objections)
      ? data.objections.filter(
          (x): x is NewObjection =>
            !!x &&
            typeof x === "object" &&
            typeof (x as NewObjection).type === "string" &&
            VALID_OBJECTION_TYPES.has((x as NewObjection).type) &&
            typeof (x as NewObjection).customerQuote === "string" &&
            (x as NewObjection).customerQuote.trim().length > 0 &&
            typeof (x as NewObjection).counterThatWorked === "string" &&
            (x as NewObjection).counterThatWorked.trim().length > 0
        )
      : [];
    return { insights, objections };
  } catch {
    return null;
  }
}

async function offsetMs(): Promise<number> {
  const raw = (await getSetting("timezoneOffsetHours"))?.trim();
  const value = raw ? Number(raw) : NaN;
  return (Number.isFinite(value) ? value : DEFAULT_OFFSET_HOURS) * 3_600_000;
}

/**
 * ПАКЕТНЫЙ РЕЖИМ (30.08.2026): ночной разбор — идеальный кандидат на Batch API
 * (скидка 50%, ответ в течение суток, ждать некому). Схема двухфазная:
 * в 3 ночи задание ОТПРАВЛЯЕТСЯ и его имя ложится в эту настройку; дальше общий
 * тик раз в ~10 минут спрашивает Google о готовности и, когда ответ пришёл,
 * применяет его тем же кодом, что и раньше. Любой сбой любого этапа — обычный
 * синхронный прогон, урок ночи не теряется (batch — скидка, не точка отказа).
 */
const BATCH_KEY = "nightlyBatchJob";
const BATCH_POLL_MS = 10 * 60_000;
let lastBatchPollAt = 0;

type PendingBatch = { name: string; model: string; day: string; soldCount: number; total: number };

/** Дёргается общим тиком, но работает раз в сутки — ночью. */
export async function maybeRunNightlyLearning(): Promise<void> {
  if ((await getSetting("nightlyLearningEnabled")) === "false") return;

  // Фаза 2: висит ли неоплаченное задание — проверяем независимо от часа,
  // ответ Google может прийти и днём.
  await maybeCollectBatch();

  const offset = await offsetMs();
  const local = new Date(Date.now() + offset);
  const today = local.toISOString().slice(0, 10);
  if (local.getUTCHours() < RUN_HOUR) return;
  if ((await getSetting(SENT_KEY))?.trim() === today) return;

  // Отметка — ДО работы: разбор дорогой, и лучше пропустить ночь при сбое, чем
  // гонять модель каждые 10 секунд до утра.
  await setSetting(SENT_KEY, today);
  try {
    await runLearning(offset);
  } catch (err) {
    logError("nightlyLearning", err);
  }
}

/** Фаза 2: забрать готовый пакетный результат, если он созрел. */
async function maybeCollectBatch(): Promise<void> {
  if (Date.now() - lastBatchPollAt < BATCH_POLL_MS) return;
  const raw = (await getSetting(BATCH_KEY))?.trim();
  if (!raw) return;
  lastBatchPollAt = Date.now();

  let job: PendingBatch;
  try {
    job = JSON.parse(raw) as PendingBatch;
  } catch {
    await setSetting(BATCH_KEY, "");
    return;
  }

  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) return;

  const startedAt = Date.now();
  const poll = await pollGeminiBatch(apiKeys[0], job.name);
  if (poll.status === "pending") return;

  await setSetting(BATCH_KEY, "");
  if (poll.status === "failed") {
    // Пакет умер — прогоняем ту же ночь обычным путём, урок не теряется.
    logError("nightlyLearning", `пакетное задание не доехало (${poll.detail}) — синхронный фоллбек`);
    void logAiCall({ endpoint: "nightly-learning-batch", ms: Date.now() - startedAt, ok: false });
    try {
      await runLearning(await offsetMs(), { forceSync: true });
    } catch (err) {
      logError("nightlyLearning", err);
    }
    return;
  }

  // Скидка Batch — 50%: пишем половинные токены, чтобы строка расходов не
  // завышала цену вдвое (отдельного поля «пакетный тариф» в учёте нет).
  void logAiCall({
    endpoint: "nightly-learning-batch",
    model: job.model,
    usage: {
      inputTokens: Math.round(poll.usage.inputTokens / 2),
      outputTokens: Math.round(poll.usage.outputTokens / 2),
      cacheReadTokens: Math.round(poll.usage.cacheReadTokens / 2),
    },
    ms: Date.now() - startedAt,
    ok: true,
  });
  await applyNightlyText(poll.text, job.day, job.soldCount, job.total);
}

async function runLearning(offset: number, opts: { forceSync?: boolean } = {}): Promise<void> {
  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) return;

  // Разбираем ПРОШЕДШИЕ сутки целиком: запуск идёт в 3 ночи, и «вчера» — это
  // полный рабочий день, а не огрызок с полуночи.
  const localMidnight = new Date(Date.now() + offset);
  localMidnight.setUTCHours(0, 0, 0, 0);
  const to = new Date(localMidnight.getTime() - offset);
  const from = new Date(to.getTime() - 86_400_000);

  const dialogs = await collectDialogs(from, to);
  if (dialogs.length === 0) return;

  const model = (await getSetting("aiModel")) || "gemini-3.7-flash";
  const day = from.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  const soldCount = dialogs.filter((d) => d.sold).length;

  // ФАЗА 1: пробуем пакетным заданием — те же токены за полцены, ответ заберёт
  // maybeCollectBatch. Не вышло отправить (сеть, отказ) — обычный путь ниже,
  // как жил всегда. forceSync — это и есть фоллбек после умершего пакета:
  // второй раз в пакет не ходим, чтобы не зациклиться.
  if (!opts.forceSync && (await getSetting("nightlyLearningBatchEnabled")) !== "false") {
    const submitted = await submitGeminiBatch({
      apiKey: apiKeys[0],
      model,
      displayName: `nightly-${from.toISOString().slice(0, 10)}`,
      request: {
        contents: [{ role: "user", parts: [{ text: buildPrompt(dialogs) }] }],
        generationConfig: {
          thinkingConfig: thinkingConfigFor(model),
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
        },
      },
    });
    if (submitted) {
      const job: PendingBatch = { name: submitted.name, model, day, soldCount, total: dialogs.length };
      await setSetting(BATCH_KEY, JSON.stringify(job));
      return;
    }
    logError("nightlyLearning", "пакетное задание не отправилось — обычный синхронный прогон");
  }

  const startedAt = Date.now();
  const result = await generateWithFallback(
    apiKeys,
    model,
    (m) =>
      JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(dialogs) }] }],
        generationConfig: {
          thinkingConfig: thinkingConfigFor(m),
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
        },
      }),
    BUDGET_MS
  );
  if ("error" in result || !result.text?.trim()) {
    logError("nightlyLearning", "error" in result ? result.error : "пустой ответ");
    void logAiCall({ endpoint: "nightly-learning", ms: Date.now() - startedAt, ok: false });
    return;
  }
  void logAiCall({ endpoint: "nightly-learning", model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });
  await applyNightlyText(result.text, day, soldCount, dialogs.length);
}

/** Применение готового текста разбора — общее для синхронного и пакетного пути:
 *  разойтись они не имеют права, иначе пакетная ночь учила бы бота иначе. */
async function applyNightlyText(text: string, day: string, soldCount: number, total: number): Promise<void> {
  const parsed = parseNightlyResult(text);
  if (!parsed) {
    logError("nightlyLearning", `Gemini вернул не-JSON: ${text.slice(0, 200)}`);
    return;
  }
  if (parsed.insights.length > 0) {
    await setSetting(
      INSIGHTS_KEY,
      `Разбор переписок за ${day} (${soldCount} с покупкой из ${total}):\n${parsed.insights.join("\n")}`
    );
  }
  await mergeObjectionEntries(parsed.objections);
}

/**
 * Приложение к промту. Возвращает пустую строку, если разбора ещё не было —
 * тогда бот работает ровно как раньше.
 */
export async function buildInsightsBlock(): Promise<string> {
  const insights = (await getSetting(INSIGHTS_KEY))?.trim();
  if (!insights) return "";
  return (
    "\n\nЧТО ПОКАЗАЛ РАЗБОР ВЧЕРАШНИХ ПЕРЕПИСОК (учитывай, но правила выше важнее):\n" + insights
  );
}
