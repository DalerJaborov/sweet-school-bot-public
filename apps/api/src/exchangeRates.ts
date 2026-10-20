import { getSetting, logError } from "./db.js";

/**
 * Курсы валют к сомони — чтобы принимать чеки из-за границы.
 *
 * ЗАЧЕМ. Ученицы часто платят из России, и в чеке стоит «635 ₽», а не «70
 * сомони». Сверять такую сумму с ценой курса напрямую нельзя: 635 не похоже ни
 * на 50, ни на 70, и честная оплата уходила бы владельцу как подозрительная.
 * Переводим по текущему курсу и сверяем уже в сомони. (Проверка: первая живая
 * оплата пришла на 635 ₽, а 70 сомони по курсу того дня — 636 ₽.)
 *
 * ДВА ИСТОЧНИКА. Оба открытые и доступны с нашего VPS (проверено). Если оба
 * молчат — берём последний удачный ответ из памяти, а если и его нет, курс
 * возвращается null: тогда чек не отвергается, а уходит владельцу на глаза.
 * Молча считать по устаревшему «примерно» нельзя — это деньги.
 */

const PRIMARY = "https://open.er-api.com/v6/latest/TJS";
const BACKUP = "https://www.floatrates.com/daily/tjs.json";
/** Курс живёт полсуток: банковские курсы меняются раз в день, а лишний поход в
 *  сеть на каждом чеке — лишняя точка отказа в денежном пути. */
const MAX_AGE_MS = 12 * 3_600_000;
/** Максимальный возраст кэша, после которого он считается «слишком старым» даже
 *  для fallback. Если оба источника молчат дольше этого порога, лучше вернуть
 *  null и отправить чек владельцу, чем считать по курсу недельной давности —
 *  это деньги, и ошибка здесь дороже одного ручного решения. */
const MAX_STALE_MS = 48 * 3_600_000;
const TIMEOUT_MS = 10_000;

/** Сколько ЕДИНИЦ валюты в одном сомони (1 сомони = 9.09 RUB и т.п.). */
type Rates = Record<string, number>;

let cache: { rates: Rates; at: number } | null = null;

/** Принудительное обновление кэша — используется, когда владелец вручную
 *  изменил курс в настройках или после деплоя, чтобы не ждать полсуток. */
export function invalidateRateCache(): void {
  cache = null;
}

async function fetchPrimary(): Promise<Rates | null> {
  const res = await fetch(PRIMARY, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: string; rates?: Rates };
  if (data.result !== "success" || !data.rates) return null;
  return data.rates;
}

async function fetchBackup(): Promise<Rates | null> {
  const res = await fetch(BACKUP, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  // floatrates отдаёт «сколько сомони в единице валюты» — переворачиваем.
  const data = (await res.json()) as Record<string, { code?: string; rate?: string }>;
  const rates: Rates = {};
  for (const row of Object.values(data)) {
    const value = Number(row.rate);
    if (row.code && Number.isFinite(value) && value > 0) rates[row.code.toUpperCase()] = value;
  }
  return Object.keys(rates).length > 0 ? rates : null;
}

async function rates(): Promise<Rates | null> {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return cache.rates;
  for (const load of [fetchPrimary, fetchBackup]) {
    try {
      const fresh = await load();
      if (fresh) {
        cache = { rates: fresh, at: Date.now() };
        return fresh;
      }
    } catch (err) {
      logError("exchangeRates", err);
    }
  }
  // Оба источника молчат — используем кэш только если он не слишком старый.
  // Курс недельной давности на сумме в 70 сомони может дать ошибку в десятки
  // рублей, и это деньги: лучше отправить чек владельцу, чем считать вслепую.
  if (cache && Date.now() - cache.at < MAX_STALE_MS) return cache.rates;
  logError(
    "exchangeRates:staleCache",
    new Error(
      `Both rate sources failed and cache is ${cache ? Math.round((Date.now() - cache.at) / 3_600_000) + "h old" : "empty"} — returning null`
    )
  );
  return null;
}

/** Ручной курс из Настроек: `rateRUB`, `rateUSD` — сколько единиц валюты в одном
 *  сомони. Задан — верим ему и в сеть не ходим (владелец видит чек глазами). */
async function manualRate(currency: string): Promise<number | null> {
  const raw = (await getSetting(`rate${currency}`))?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Переводит сумму в сомони. Возвращает null, если валюта незнакома или курс
 * получить не удалось — вызывающий код в этом случае обязан показать чек
 * владельцу, а не отвергать его.
 */
export async function toSomoni(amount: number, currency: string | null | undefined): Promise<number | null> {
  const code = (currency ?? "TJS").trim().toUpperCase();
  if (!code || code === "TJS" || code === "SOMONI" || code === "СОМОНИ") return amount;

  const manual = await manualRate(code);
  if (manual) return amount / manual;

  const table = await rates();
  const perSomoni = table?.[code];
  if (!perSomoni || perSomoni <= 0) return null;
  return amount / perSomoni;
}
