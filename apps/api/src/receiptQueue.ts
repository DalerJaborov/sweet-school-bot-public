/**
 * ДЕНЬГИ ОДНОГО ЧЕЛОВЕКА - ПО ОДНОМУ (ревью PR 72).
 *
 * Разбор чека, кнопка Ширин «Подтвердить» и ответ клиентки «да» про Telegram
 * выдают доступ одной и той же покупке. Параллельно они не видели строк друг
 * друга: второй продолжал доставку, которую первый ещё не закончил, и клиентке
 * уходили ДВЕ одноразовые ссылки. Деньги защищает уникальность покупки в базе;
 * эта очередь убирает вторую ссылку и лишнюю карточку.
 *
 * api работает одним процессом (docker-compose), поэтому замка в памяти
 * достаточно; при нескольких копиях api нужен замок в базе.
 *
 * Внутри очереди нельзя снова звать очередь того же человека - будет вечное
 * ожидание. Сейчас ни разбор чека, ни решение Ширин, ни ответ про Telegram друг
 * друга не вызывают.
 */
const queues = new Map<string, Promise<void>>();

export async function oneAtATimeForContact<T>(contactId: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(contactId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => mine);
  queues.set(contactId, tail);
  try {
    await before;
    return await run();
  } finally {
    release();
    if (queues.get(contactId) === tail) queues.delete(contactId);
  }
}
