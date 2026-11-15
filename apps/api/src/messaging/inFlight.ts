/**
 * ОТПРАВКА «В ПОЛЁТЕ» — ЧТОБЫ ЭХО НАШЕГО ЖЕ СООБЩЕНИЯ НЕ СЧИТАЛОСЬ ОТВЕТОМ ШИРИН
 * (аудит 15.11.2026, «бот молча не ответил клиенту»).
 *
 * Meta присылает эхо исходящего вебхуком, и оно нередко приходит РАНЬШЕ, чем
 * Graph API вернул нам mid. handleEcho (webhook.ts) не находил mid в базе и
 * записывал наш ответ как «Ширин ответила сама»: ставил паузу бота, отменял
 * шаги воронки, стирал «клиент просил человека». recordOutgoingMessage (db.ts)
 * потом чинил отметку паузы, но не остальное — а сообщение клиента, пришедшее в
 * это окно, бот молча пропускал (webhook.ts: «пауза — молчим»), и сторож его не
 * видел: пауза к тому времени уже «исчезла».
 *
 * Теперь каждая отправка в Instagram/Messenger вместе с записью mid в историю
 * идёт внутри trackOutgoing(igUserId). Эхо с незнакомым mid к человеку, которому
 * мы прямо сейчас пишем, ждёт конца отправки и проверяет mid ещё раз.
 *
 * Один процесс (SQLite, один контейнер) — счётчик в памяти, как в debounce.ts.
 */
const inFlight = new Map<string, number>();
const idleWaiters = new Map<string, (() => void)[]>();

export async function trackOutgoing<T>(recipientId: string | null | undefined, send: () => Promise<T>): Promise<T> {
  if (!recipientId) return send();
  inFlight.set(recipientId, (inFlight.get(recipientId) ?? 0) + 1);
  try {
    return await send();
  } finally {
    const left = (inFlight.get(recipientId) ?? 1) - 1;
    if (left > 0) inFlight.set(recipientId, left);
    else {
      inFlight.delete(recipientId);
      const waiters = idleWaiters.get(recipientId) ?? [];
      idleWaiters.delete(recipientId);
      waiters.forEach((wake) => wake());
    }
  }
}

export function outgoingInFlight(recipientId: string | null | undefined): boolean {
  return Boolean(recipientId && inFlight.has(recipientId));
}

/** Дождаться, пока все наши отправки этому человеку запишут mid; не дольше maxMs. */
export function waitOutgoingIdle(recipientId: string, maxMs: number): Promise<void> {
  if (!inFlight.has(recipientId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, maxMs);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      const list = idleWaiters.get(recipientId);
      if (list) {
        const i = list.indexOf(done);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) idleWaiters.delete(recipientId);
      }
      resolve();
    }
    idleWaiters.set(recipientId, [...(idleWaiters.get(recipientId) ?? []), done]);
  });
}
