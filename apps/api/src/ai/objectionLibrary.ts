import { getSetting, setSetting, logError } from "../db.js";

/**
 * БИБЛИОТЕКА ВОЗРАЖЕНИЙ — отдельная от salesInsights (nightlyLearning.ts) память.
 *
 * salesInsights — это общие наблюдения маркетолога («сегодня люди чаще спрашивали
 * про рассрочку»), они меняются целиком каждую ночь и не привязаны к конкретной
 * фразе. Эта библиотека — другое: конкретные пары «как именно клиент возразил» →
 * «что именно ответили, и это сработало» (разговор дошёл до оплаты). Растёт со
 * временем, дедуплицируется и не превышает разумный размер — тот же приём, что у
 * styleExample в styleLearning.ts, но храним не в таблице, а в Setting (как
 * quickReplies.ts): записей мало, отдельная таблица ради этого — лишняя сущность.
 *
 * Наполняет её nightlyLearning.ts (ночной разбор дня), читает — buildObjectionsBlock
 * ниже, подмешивается в промт из ai.ts рядом с buildInsightsBlock.
 */

export type ObjectionType = "цена" | "муж" | "недоверие" | "конкуренты" | "откладывает" | "другое";

const VALID_TYPES: ReadonlySet<string> = new Set<ObjectionType>([
  "цена",
  "муж",
  "недоверие",
  "конкуренты",
  "откладывает",
  "другое",
]);

export type ObjectionEntry = {
  type: ObjectionType;
  /** Дословная (или близкая к дословной) фраза клиента — не пересказ. */
  customerQuote: string;
  /** Дословный ответ, после которого разговор всё же дошёл до оплаты. */
  counterThatWorked: string;
  createdAt: string; // ISO — по нему решаем, что подрезать при переполнении
};

export type NewObjection = { type: string; customerQuote: string; counterThatWorked: string };

const SETTING_KEY = "objectionLibrary";
const MAX_TOTAL = 40;
const MAX_IN_PROMPT = 40; // v1: список короткий, отбирать по релевантности пока незачем
const MAX_QUOTE_LEN = 300;
const MAX_COUNTER_LEN = 400;

/** lowercase + без пунктуации + схлопнутые пробелы — простое сравнение «почти
 *  та же фраза», без embeddings и прочего для полусотни строк. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidEntry(item: unknown): item is ObjectionEntry {
  if (!item || typeof item !== "object") return false;
  const e = item as Partial<ObjectionEntry>;
  return (
    typeof e.type === "string" &&
    VALID_TYPES.has(e.type) &&
    typeof e.customerQuote === "string" &&
    e.customerQuote.trim().length > 0 &&
    typeof e.counterThatWorked === "string" &&
    e.counterThatWorked.trim().length > 0 &&
    typeof e.createdAt === "string"
  );
}

/** Читает библиотеку из Setting; битый JSON или пустая настройка — пустой
 *  список (не бросаем ошибку — бот должен работать и без неё, как раньше). */
export async function getObjectionLibrary(): Promise<ObjectionEntry[]> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

/** Если записей больше лимита — подрезаем, но не просто «самые старые вообще»:
 *  забираем самую старую запись у ТОГО типа, которого сейчас больше всего.
 *  Иначе частый тип («цена» всплывает каждый день) со временем вытеснил бы
 *  редкие («муж») из библиотеки целиком. */
function capBalanced(list: ObjectionEntry[], max: number): ObjectionEntry[] {
  if (list.length <= max) return list;

  const byType = new Map<string, ObjectionEntry[]>();
  for (const e of list) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }
  for (const arr of byType.values()) arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const toDrop = new Set<ObjectionEntry>();
  let remaining = list.length;
  while (remaining > max) {
    let biggestType: string | null = null;
    let biggestCount = -1;
    for (const [type, arr] of byType) {
      if (arr.length > biggestCount) {
        biggestCount = arr.length;
        biggestType = type;
      }
    }
    if (!biggestType || biggestCount <= 0) break; // защита от бесконечного цикла
    const arr = byType.get(biggestType)!;
    const oldest = arr.shift();
    if (!oldest) break;
    toDrop.add(oldest);
    remaining -= 1;
  }
  return list.filter((e) => !toDrop.has(e));
}

/**
 * Добавляет новые пары «возражение → сработавший ответ», не заменяя старые.
 * Дубли (тот же тип + почти та же фраза клиента) отбрасывает; при переполнении
 * подрезает поровну по типам (см. capBalanced). Вызывается из nightlyLearning.ts
 * раз в сутки, только с парами из разговоров, которые реально закончились
 * оплатой — сюда ничего гипотетического попадать не должно.
 */
export async function mergeObjectionEntries(entries: NewObjection[]): Promise<void> {
  if (entries.length === 0) return;

  const current = await getObjectionLibrary();
  const seen = new Set(current.map((e) => `${e.type}::${normalize(e.customerQuote)}`));
  const now = new Date().toISOString();

  for (const raw of entries) {
    if (!VALID_TYPES.has(raw.type)) continue;
    const customerQuote = raw.customerQuote?.trim().slice(0, MAX_QUOTE_LEN);
    const counterThatWorked = raw.counterThatWorked?.trim().slice(0, MAX_COUNTER_LEN);
    if (!customerQuote || !counterThatWorked) continue;
    const key = `${raw.type}::${normalize(customerQuote)}`;
    if (seen.has(key)) continue; // такое возражение уже есть — не плодим почти-дубли
    seen.add(key);
    current.push({ type: raw.type as ObjectionType, customerQuote, counterThatWorked, createdAt: now });
  }

  const capped = capBalanced(current, MAX_TOTAL);
  try {
    await setSetting(SETTING_KEY, JSON.stringify(capped));
  } catch (err) {
    logError("objectionLibrary:merge", err);
  }
}

/**
 * Приложение к промту — отдельная секция от salesInsights: там общие заметки,
 * здесь конкретные пары с точной формулировкой клиента, чтобы бот узнавал то же
 * возражение и не изобретал ответ заново, а брал доказанно рабочий.
 * Пустая строка, если библиотека ещё не набралась — бот работает как раньше.
 */
export async function buildObjectionsBlock(): Promise<string> {
  const list = await getObjectionLibrary();
  if (list.length === 0) return "";

  const take = list.slice(0, MAX_IN_PROMPT);
  const lines = take.map((e) => `[${e.type}] Клиент: «${e.customerQuote}» → Сработало: «${e.counterThatWorked}»`);
  return (
    "\n\nБИБЛИОТЕКА ВОЗРАЖЕНИЙ — реальные случаи из переписок, где именно такой ответ довёл разговор до оплаты. " +
    "Если сейчас клиент говорит что-то похожее по смыслу (даже другими словами) — используй ту же идею ответа, " +
    "подгоняя под ситуацию, а не копируя дословно, если не подходит:\n\n" + lines.join("\n")
  );
}
