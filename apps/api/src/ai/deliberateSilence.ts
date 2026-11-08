/**
 * ЖУРНАЛ НАМЕРЕННОГО МОЛЧАНИЯ: «бот промолчал не случайно, и вот почему».
 *
 * Сторож неотвеченных (inboundWatch.ts, checkUnansweredInbound) поднимает тревогу,
 * если на сообщение клиента никто не ответил две минуты. Часть молчаний — решения
 * владельца (просят бесплатно, назойливость, «спасибо» без вопроса, явная метка
 * NO_REPLY). Каждое такое место записывает причину сюда, и сторож их пропускает.
 * Всё, чего здесь нет, — молчание без причины и повод для тревоги.
 *
 * Память процесса: при перезапуске сторож смотрит только сообщения, пришедшие
 * после старта, поэтому забытые записи ложной тревоги не дают.
 */

type Entry = { reason: string; at: number };

const entries = new Map<string, Entry>();
const TTL_MS = 24 * 3_600_000;

export function noteDeliberateSilence(contactId: string, reason: string): void {
  const now = Date.now();
  entries.set(contactId, { reason, at: now });
  if (entries.size > 2000) {
    for (const [id, e] of entries) if (now - e.at > TTL_MS) entries.delete(id);
  }
}

/** Причина намеренного молчания, записанная не раньше `since`; иначе null. */
export function deliberateSilenceSince(contactId: string, since: Date): string | null {
  const e = entries.get(contactId);
  return e && e.at >= since.getTime() ? e.reason : null;
}

/** Только для тестов. */
export function resetDeliberateSilence(): void {
  entries.clear();
}
