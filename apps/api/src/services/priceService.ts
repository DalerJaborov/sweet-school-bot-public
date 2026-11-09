import { getSetting } from "../db.js";
import { COURSE_50, COURSE_70, DEFAULT_PRICES, priceTable, type PriceTable } from "../prices.js";

/**
 * ЦЕНЫ — ИЗ НАСТРОЕК, С КОНСТАНТАМИ prices.ts КАК ЗАПАСНЫМ ВАРИАНТОМ.
 *
 * До раздела «Тексты и цены» сменить цену было нельзя иначе как правкой кода
 * и деплоем: цифры сидели в prices.ts, а Course.price в таблице (то, что
 * показывает сайт) жил своей жизнью. Теперь панель пишет ОБА места разом
 * (savePrices), а всё, что считает деньги — allocate(), проверка чека,
 * промт, каталог сайта — читает отсюда.
 *
 * КЭШ КОРОТКИЙ (30 с): цены спрашиваются на каждом ходе бота, а меняются раз
 * в полгода. Запись сбрасывает кэш сразу — владелец видит новую цену в
 * следующем же сообщении, не через полминуты.
 */

const CACHE_TTL_MS = 30_000;
let cache: { at: number; table: PriceTable } | null = null;

/** Число из настройки; пусто, мусор или ноль — значение по умолчанию. */
function intOr(raw: string | null, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getPrices(): Promise<PriceTable> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.table;
  const [c50, c70, bundle] = await Promise.all([
    getSetting("priceCourse50"),
    getSetting("priceCourse70"),
    getSetting("priceBundle"),
  ]);
  const table = priceTable(
    intOr(c50, DEFAULT_PRICES.price[COURSE_50]),
    intOr(c70, DEFAULT_PRICES.price[COURSE_70]),
    intOr(bundle, DEFAULT_PRICES.bundle),
  );
  cache = { at: Date.now(), table };
  return table;
}

/**
 * ДОПУСК ПО СУММЕ ЧЕКА (08.11.2026, раздел «Цены и даты»).
 *
 * down — сколько сомони может «не дойти» из-за комиссии банка (отправила 70,
 * получатель видит 64–70). up — на сколько сомони чек может быть больше цены:
 * комиссия, добавленная сверху (71.45 за курс за 70), округление, пересчёт из
 * рублей по курсу. Недоплата больше down по-прежнему уходит владельцу.
 * Реальные чеки на проде: 70 → 70, 71, 72, 73; из рублей — до 78.
 */
export type PaymentTolerance = { down: number; up: number };
export const DEFAULT_PAYMENT_TOLERANCE: PaymentTolerance = { down: 6, up: 30 };
/** Потолки: допуск вниз шире 15 сомони — уже недоплата, вверх шире 60 — мусор. */
export const MAX_TOLERANCE_DOWN = 15;
export const MAX_TOLERANCE_UP = 60;

function toleranceOr(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

export async function getPaymentTolerance(): Promise<PaymentTolerance> {
  const [down, up] = await Promise.all([getSetting("receiptToleranceDown"), getSetting("receiptToleranceUp")]);
  return {
    down: toleranceOr(down, DEFAULT_PAYMENT_TOLERANCE.down, MAX_TOLERANCE_DOWN),
    up: toleranceOr(up, DEFAULT_PAYMENT_TOLERANCE.up, MAX_TOLERANCE_UP),
  };
}

/** Сбросить кэш — после записи и в тестах. */
export function resetPriceCache(): void {
  cache = null;
}

// Запись цен — только services/offerService.saveOffer (Settings + Course.price
// + журнал в одной транзакции). Отдельного savePrices больше нет: второй путь
// записи без проверки и журнала — ровно то, что раздел «Цены и даты» убирает.
