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

/** Сбросить кэш — после записи и в тестах. */
export function resetPriceCache(): void {
  cache = null;
}

// Запись цен — только services/offerService.saveOffer (Settings + Course.price
// + журнал в одной транзакции). Отдельного savePrices больше нет: второй путь
// записи без проверки и журнала — ровно то, что раздел «Цены и даты» убирает.
