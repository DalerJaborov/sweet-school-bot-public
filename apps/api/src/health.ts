import { prisma } from "./db.js";
import { diskState } from "./diskWatch.js";
import { stuckWorkers } from "./workerHealth.js";
import { inboundSilenceState } from "./inboundWatch.js";

/**
 * ЧЕСТНАЯ ПРОВЕРКА ЗДОРОВЬЯ.
 *
 * Раньше `/health` отвечал `{ok:true}` всегда — то есть был зелёным и при
 * заблокированной базе, и при полном диске, и при мёртвых фоновых задачах.
 * Такая проверка хуже отсутствующей: на неё смотрят и делают ложный вывод.
 *
 * Здесь три вещи, каждая из которых ломает бота целиком:
 *  • база отвечает на запрос;
 *  • на диске есть место (иначе SQLite перестанет писать, см. diskWatch.ts);
 *  • фоновый круг задач замыкается (иначе воронки, догоняющие и перепроверка
 *    чеков молча останавливаются — так уже было 03.09.2026).
 *
 * Плохо хоть что-то — отдаём 503. По этому коду внешний наблюдатель поднимет
 * тревогу, даже когда сам сервер жив и отвечает: «страница открывается» и
 * «бот работает» — разные вещи.
 */

/** Свободного места меньше — считаем нездоровьем: до отказа записи недалеко. */
const MIN_FREE_PCT = 5;
/** Фоновый тик идёт раз в 10 секунд. Пять минут тишины — уже не задержка. */
const STALE_TICK_MS = 5 * 60_000;

let lastTickAt = Date.now();

/** Отмечает, что круг фоновых задач завершился. Вызывается из index.ts. */
export function markWorkerTick(): void {
  lastTickAt = Date.now();
}

export type HealthReport = {
  ok: boolean;
  db: boolean;
  diskFreePct: number | null;
  secondsSinceWorkerTick: number;
  problems: string[];
};

export async function healthReport(): Promise<HealthReport> {
  const problems: string[] = [];

  // Запрос с потолком: заблокированная база не должна подвесить саму проверку.
  const db = await Promise.race([
    prisma
      .$queryRawUnsafe("SELECT 1")
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000).unref?.()),
  ]);
  if (!db) problems.push("база не отвечает");

  const disk = await diskState();
  if (disk && disk.freePct < MIN_FREE_PCT) {
    problems.push(`на диске свободно ${disk.freePct}%`);
  }

  const sinceTick = Date.now() - lastTickAt;
  if (sinceTick > STALE_TICK_MS) {
    problems.push(`фоновые задачи молчат ${Math.round(sinceTick / 60_000)} мин`);
  }

  // Тик крутится, а отдельная задача не отвечает — раньше это было невидимо.
  for (const w of stuckWorkers()) {
    problems.push(`задача ${w.name} зависла (${w.timeouts} тайм-аутов подряд)`);
  }

  // Внутри всё зелёное, а снаружи никто не пишет — самый тихий отказ.
  const inbound = inboundSilenceState();
  if (inbound.alerting) problems.push(`входящих нет ${Math.floor(inbound.silentHours)} ч в рабочее время`);

  return {
    ok: problems.length === 0,
    db,
    diskFreePct: disk?.freePct ?? null,
    secondsSinceWorkerTick: Math.round(sinceTick / 1000),
    problems,
  };
}
