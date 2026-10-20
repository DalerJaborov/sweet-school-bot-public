/**
 * ЗДОРОВЬЕ ФОНОВЫХ ЗАДАЧ — ЧТОБЫ /health ВИДЕЛ ЗАВИСШУЮ, А НЕ ТОЛЬКО МЁРТВЫЙ ТИК.
 *
 * Разбор надёжности 03.09.2026: общий тик в index.ts даёт каждой задаче две
 * минуты и идёт дальше. Значит тик всегда «замыкается», /health зелёный, а
 * одна задача может молча висеть сутками — перепроверка чеков, напоминания
 * или воронки просто перестают работать. В логе — worker:timeout раз в десять
 * секунд, но тревога владельцу по нему уходит один раз за всю историю (дедуп).
 *
 * Здесь считаем ПОДРЯД идущие тайм-ауты по имени задачи. Один-два — шум
 * (медленный Gemini). Три подряд — задача не отвечает, и это должно быть
 * видно снаружи: /health отдаёт 503 с именем, а владельцу уходит прямое
 * сообщение без дедупа.
 */

/** Столько тайм-аутов подряд — уже не задержка. */
export const STUCK_AFTER = 3;

const consecutive = new Map<string, number>();

/** Задача уложилась — счётчик в ноль. */
export function markWorkerOk(name: string): void {
  consecutive.delete(name);
}

/** Задача не уложилась. Возвращает true ровно в момент, когда порог достигнут
 *  впервые — вызывающий шлёт тревогу один раз, а не на каждом тике. */
export function markWorkerTimeout(name: string): boolean {
  const n = (consecutive.get(name) ?? 0) + 1;
  consecutive.set(name, n);
  return n === STUCK_AFTER;
}

/** Имена задач, которые сейчас считаются зависшими, с числом тайм-аутов. */
export function stuckWorkers(): { name: string; timeouts: number }[] {
  return [...consecutive.entries()].filter(([, n]) => n >= STUCK_AFTER).map(([name, timeouts]) => ({ name, timeouts }));
}

/** Только для тестов. */
export function resetWorkerHealth(): void {
  consecutive.clear();
}
