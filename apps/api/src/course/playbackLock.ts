/**
 * ОДНОВРЕМЕННЫЙ ПРОСМОТР С ДВУХ ТЕЛЕФОНОВ ЗАПРЕЩЁН (владелец 08.11.2026).
 *
 * Держатель — УСТРОЙСТВО (Device), а не вкладка и не браузер: несколько
 * вкладок и браузеров одного телефона делят одну запись устройства, поэтому
 * друг друга не блокируют. Замок продлевают запросы ключа и отметки прогресса
 * (плеер шлёт их раз в ~10 секунд), и он гаснет сам через две минуты тишины,
 * чтобы не залипнуть после закрытой вкладки или потери связи.
 *
 * Хранится в памяти процесса. Это осознанно: замок короткий, перезапуск
 * сервера лишь на минуту ослабляет запрет. Если появится несколько процессов
 * API, замок нужно перенести в общее хранилище.
 */

const HOLD_MS = 120_000;
const holders = new Map<string, { deviceId: string; at: number }>();

/** true — этому устройству можно играть (замок взят или продлён). */
export function claimPlayback(contactId: string, deviceId: string, now = Date.now()): boolean {
  const cur = holders.get(contactId);
  if (cur && cur.deviceId !== deviceId && now - cur.at < HOLD_MS) return false;
  holders.set(contactId, { deviceId, at: now });
  return true;
}

/** Только для тестов. */
export function resetPlaybackLocks(): void {
  holders.clear();
}
