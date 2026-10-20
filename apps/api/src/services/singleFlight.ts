/**
 * ОДИН ПРОГОН ЗА РАЗ — С ПРЕДОХРАНИТЕЛЕМ ОТ ВЕЧНОГО «ЗАНЯТО».
 *
 * Семь фоновых задач держали одинаковый флаг `busy`: если прошлый прогон ещё
 * идёт, новый тик пропускается. Верно, но с дырой, найденной разбором
 * надёжности 03.09.2026: если прогон ЗАВИС (сетевой вызов без таймаута,
 * промис, который никогда не завершится), флаг не опускается никогда. Общий
 * тик в index.ts через две минуты сдаётся и идёт дальше — а эта задача мертва
 * до перезапуска контейнера, и по /health этого не видно: тик-то крутится.
 *
 * Здесь тот же флаг, но с часами: прогон старше `maxMs` считаем зависшим,
 * флаг сбрасываем и запускаем заново. Повисший промис при этом остаётся
 * висеть — убить его нельзя — но задача снова работает, а в журнал уходит
 * ошибка с именем задачи, чтобы найти виновника.
 */

import { logError } from "../db.js";

/** Дольше этого честный прогон не идёт: очередь чеков, напоминания, профили —
 *  всё укладывается в секунды. Десять минут — с большим запасом. */
const DEFAULT_MAX_MS = 10 * 60_000;

type Flight = { startedAt: number };

const flights = new Map<string, Flight>();

/**
 * Выполнить `fn`, если по этому имени сейчас ничего не идёт. Возвращает true,
 * если прогон состоялся, false — пропущен из-за занятости.
 */
export async function singleFlight(name: string, fn: () => Promise<void>, maxMs = DEFAULT_MAX_MS): Promise<boolean> {
  const current = flights.get(name);
  if (current) {
    const age = Date.now() - current.startedAt;
    if (age < maxMs) return false;
    // Зависший прогон. Сбрасываем и идём дальше — иначе задача не оживёт до
    // перезапуска, и никто об этом не узнает.
    logError(`singleFlight:${name}`, new Error(`прогон завис на ${Math.round(age / 60_000)} мин — сбрасываю и запускаю заново`));
  }
  const mine: Flight = { startedAt: Date.now() };
  flights.set(name, mine);
  try {
    await fn();
  } finally {
    // Снимаем только СВОЙ флаг: зависший прогон, очнувшись через полчаса, не
    // должен сбросить флаг того, кто запустился вместо него.
    if (flights.get(name) === mine) flights.delete(name);
  }
  return true;
}

/** Для тестов и /health: имена задач, которые сейчас идут, и как давно. */
export function inFlight(): { name: string; ageMs: number }[] {
  const now = Date.now();
  return [...flights.entries()].map(([name, f]) => ({ name, ageMs: now - f.startedAt }));
}

/** Только для тестов. */
export function resetFlights(): void {
  flights.clear();
}
