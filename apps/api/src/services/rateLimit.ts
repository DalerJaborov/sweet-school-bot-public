/**
 * ЛИМИТ ЧАСТОТЫ В ПАМЯТИ — для публичных маршрутов сайта.
 *
 * Чат на сайте открыт без входа: любой скрипт может слать сообщения, а каждое
 * из них — платный ход модели и строка в базе. express-rate-limit не тянем ради
 * одного окна: живём в одном процессе (SQLite, один контейнер), и скользящее
 * окно на Map с периодической чисткой закрывает вопрос без зависимости.
 *
 * Окно СКОЛЬЗЯЩЕЕ (список отметок времени), а не «счётчик до конца минуты»:
 * фиксированное окно пропускает двойную норму на стыке двух окон.
 */

export type RateVerdict = { ok: true } | { ok: false; retryAfterSec: number };

export type RateLimiter = {
  hit(key: string): RateVerdict;
  /** Только для тестов: забыть всё. */
  reset(): void;
};

const PRUNE_EVERY_MS = 60_000;

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastPrune = now();

  function prune(at: number): void {
    if (at - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = at;
    for (const [key, stamps] of hits) {
      const alive = stamps.filter((t) => at - t < opts.windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  return {
    hit(key) {
      const at = now();
      prune(at);
      const alive = (hits.get(key) ?? []).filter((t) => at - t < opts.windowMs);
      if (alive.length >= opts.limit) {
        hits.set(key, alive);
        // Самая старая отметка выйдет из окна первой — столько и ждать.
        const retryAfterMs = alive[0] + opts.windowMs - at;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      alive.push(at);
      hits.set(key, alive);
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}
