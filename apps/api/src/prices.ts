/**
 * ЦЕНЫ И НАЗВАНИЯ ОНЛАЙН-КУРСОВ — ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ (05.09.2026).
 *
 * Отдельно от courses.ts нарочно: тот тянет Prisma (ownedCourses/allocate),
 * а цены нужны и там, где базы быть не должно — в текстах промта
 * (ai/prompts.ts проверяется тестом без загрузки БД) и в инструкции проверки
 * чека. Ревью 05.09.2026 нашло четыре расходящихся источника цен: сайт говорил
 * «100 вместо 120», бот — «за оба 120», код считал 100 договорной скидкой.
 *
 * С раздела «Тексты и цены» в панели (05.09.2026, вечер) настоящие цены живут
 * в Settings (priceCourse50 / priceCourse70 / priceBundle) и читаются через
 * services/priceService.ts — с этими константами как значениями по
 * умолчанию. Этот файл остаётся БЕЗ ЗАВИСИМОСТЕЙ: только числа, строки и
 * чистые функции, которые собирают из таблицы цен фразу для модели.
 */

export const COURSE_50 = "COURSE50";
export const COURSE_70 = "COURSE70";

export type Course = typeof COURSE_50 | typeof COURSE_70;

/** Названия без цены в скобках: цена живёт в PRICE, а название печатается на
 *  ссылках, в карточках владельцу и в приложении — там «(50 сомони)» лишнее. */
export const COURSE_TITLE: Record<Course, string> = {
  [COURSE_50]: "Арт-десерты",
  [COURSE_70]: "21 рецепт",
};

/** Таблица цен, которую читают бот, чек, allocate() и сайт. */
export type PriceTable = {
  price: Record<Course, number>;
  /** Публичная цена комплекта «оба курса» — её называют и сайт, и бот. */
  bundle: number;
  /** Сумма двух курсов по отдельности — то, «вместо чего» продаётся комплект.
   *  Перевод на эту сумму тоже принимается как покупка обоих курсов. */
  bundleFull: number;
};

export const PRICE: Record<Course, number> = { [COURSE_50]: 50, [COURSE_70]: 70 };
export const BUNDLE_PRICE = 100;
export const BUNDLE_FULL_PRICE = PRICE[COURSE_50] + PRICE[COURSE_70];

export const DEFAULT_PRICES: PriceTable = { price: { ...PRICE }, bundle: BUNDLE_PRICE, bundleFull: BUNDLE_FULL_PRICE };

/** Собирает таблицу из трёх чисел; сумма двух курсов выводится, а не хранится. */
export function priceTable(course50: number, course70: number, bundle: number): PriceTable {
  return {
    price: { [COURSE_50]: course50, [COURSE_70]: course70 },
    bundle,
    bundleFull: course50 + course70,
  };
}

/** Одна фраза о ценах для модели — чтобы промт и правила не разошлись с кодом. */
export function priceLineRu(p: PriceTable = DEFAULT_PRICES): string {
  return (
    `${COURSE_TITLE[COURSE_50]} — ${p.price[COURSE_50]} сомони, ${COURSE_TITLE[COURSE_70]} — ${p.price[COURSE_70]} сомони, ` +
    `оба курса вместе — ${p.bundle} сомони`
  );
}

export const PRICE_LINE_RU = priceLineRu(DEFAULT_PRICES);
