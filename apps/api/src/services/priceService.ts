import { prisma, getSetting, logError } from "../db.js";
import { COURSE_50, COURSE_70, DEFAULT_PRICES, priceTable, type PriceTable } from "../prices.js";
import { writeSettings } from "./settingsService.js";

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
    intOr(bundle, DEFAULT_PRICES.bundle)
  );
  cache = { at: Date.now(), table };
  return table;
}

/** Сбросить кэш — после записи и в тестах. */
export function resetPriceCache(): void {
  cache = null;
}

/**
 * Записывает цены и в Settings, и в строки Course (code → price): сайт
 * показывает Course.price, и без второй записи витрина разошлась бы с ботом
 * — ровно та беда, от которой раздел и заводился. Курса в каталоге может ещё
 * не быть (до backfill) — тогда молча пропускаем, настройка всё равно
 * записана и станет ценой при заполнении каталога.
 */
export async function savePrices(input: { course50: number; course70: number; bundle: number }): Promise<PriceTable> {
  await writeSettings({
    priceCourse50: String(input.course50),
    priceCourse70: String(input.course70),
    priceBundle: String(input.bundle),
  });
  for (const [code, price] of [
    [COURSE_50, input.course50],
    [COURSE_70, input.course70],
  ] as const) {
    await prisma.course.updateMany({ where: { code }, data: { price } }).catch((err) => {
      logError("priceService:syncCourse", err);
    });
  }
  resetPriceCache();
  return getPrices();
}
