import { prisma, getSetting } from "./db.js";
import { getPrices } from "./services/priceService.js";

/**
 * ДВА КУРСА И ЧТО ЗА КАКИЕ ДЕНЬГИ ВЫДАВАТЬ.
 *
 * Раньше «оплатил» было одной галочкой на человеке. Из-за этого второй курс
 * выдать было нечем: код видел, что человек уже платил, и молчал — деньги
 * принимались, доступ не открывался. Теперь решение принимается по сумме И по
 * тому, что у человека уже куплено.
 *
 * Правила (решение владельца 21.08, цена комплекта уточнена 05.09.2026):
 *  • ~50 сомони — курс «Арт-десерты»;
 *  • ~70 сомони — курс «21 рецепт»;
 *  • ~100 — ОБА курса: это публичная цена комплекта, её называют и сайт, и бот;
 *  • ~120 (50+70) — тоже оба: человек заплатил по сумме двух курсов, ничего
 *    особенного в этом нет — просто покупка комплекта, без отдельной тревоги;
 *  • уже куплен один курс, приходит сумма второго — выдаём второй.
 *
 * Цены — из настроек через services/priceService.ts (раздел «Тексты и цены»),
 * с константами prices.ts как умолчаниями — один источник для бота, чека и сайта.
 */

// Сами цены и названия — в prices.ts (без Prisma); здесь — логика выдачи.
// Реэкспорт, чтобы остальной код по-прежнему брал всё из одного места.
export { COURSE_50, COURSE_70, COURSE_TITLE, PRICE, BUNDLE_PRICE, BUNDLE_FULL_PRICE, type Course } from "./prices.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, type Course } from "./prices.js";

/** Допуск ВНИЗ — на комиссию банка: между Алиф, ДС и Хумо удерживается процент,
 *  и из отправленных 50 доходит 45–48. Человек заплатил полную цену. */
const DOWN = 6;
/** Вверх допуск шире: заплатить больше можно (округлил, добавил комиссию сверху). */
const UP = 30;

function near(amount: number, price: number, up = UP): boolean {
  return amount >= price - DOWN && amount <= price + up;
}

/** Настройка chat_id группы для курса. */
export function chatKeyFor(course: Course): string {
  return course === COURSE_50 ? "telegramChatId50" : "telegramChatId70";
}

export async function chatIdFor(course: Course): Promise<string | null> {
  return (await getSetting(chatKeyFor(course)))?.trim() || null;
}

/** Что человек уже купил (и доступ не отобран). */
export async function ownedCourses(contactId: string): Promise<Course[]> {
  const rows = await prisma.purchase.findMany({
    where: { contactId, revokedAt: null },
    select: { course: true },
  });
  return rows.map((r) => r.course as Course);
}

export type Allocation = {
  /** Какие группы выдать ЗА ЭТОТ чек. Пусто — сумма ни на что не похожа. */
  grant: Course[];
  /** Пояснение для журнала и карточки владельцу. */
  note: string;
};

/**
 * Что открыть за присланную сумму, с учётом уже купленного.
 *
 * Возвращает ПУСТОЙ список, если сумма ни на что не похожа — тогда чек уходит
 * владельцу на глаза, а не отвергается молча и не открывает доступ наугад.
 */
export async function allocate(contactId: string, amount: number): Promise<Allocation> {
  const [owned, prices] = await Promise.all([ownedCourses(contactId), getPrices()]);
  const { price: PRICE, bundle: BUNDLE_PRICE, bundleFull: BUNDLE_FULL_PRICE } = prices;
  const missing = ([COURSE_50, COURSE_70] as Course[]).filter((c) => !owned.includes(c));

  // Всё уже куплено — новый чек не может ничего добавить: это либо повтор, либо
  // ошибка. Решает владелец.
  if (missing.length === 0) {
    return { grant: [], note: "оба курса у человека уже есть" };
  }

  // Оба сразу: от цены комплекта (минус комиссия) до суммы двух курсов с
  // запасом сверху. Проверяется ПЕРЕД одиночными курсами: полоса курса за 70
  // с допуском вверх дотягивается до 100, и без этого порядка комплект за 100
  // открывал бы один курс.
  if (missing.length === 2 && amount >= BUNDLE_PRICE - DOWN && amount <= BUNDLE_FULL_PRICE + 40) {
    return { grant: missing, note: `оплата за оба курса (${Math.round(amount)} сомони)` };
  }

  // Один курс. Берём БЛИЖАЙШУЮ по сумме цену, а не первую подходящую: допуск
  // вверх широкий (человек мог доплатить комиссию сверху), поэтому 70 сомони
  // формально попадает и в полосу пятидесятого курса — и без выбора ближайшего
  // код выдавал за 70 сомони курс за 50.
  const fits = missing
    .filter((course) => near(amount, PRICE[course]))
    .sort((a, b) => Math.abs(amount - PRICE[a]) - Math.abs(amount - PRICE[b]));
  if (fits.length > 0) {
    const course = fits[0];
    const note = owned.length > 0 ? `второй курс: ${COURSE_TITLE[course]}` : COURSE_TITLE[course];
    return { grant: [course], note };
  }

  return { grant: [], note: `сумма ${Math.round(amount)} сомони не сходится с ценами курсов` };
}
