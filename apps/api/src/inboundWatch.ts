import { prisma, getSetting, logError } from "./db.js";
import { offsetMs } from "./dailyReport.js";
import { notifyOwnerDirect } from "./systemAlerts.js";

/**
 * СТОРОЖ ВХОДЯЩИХ: «БОТ ЗАМОЛЧАЛ» — САМЫЙ ТИХИЙ ИЗ ОТКАЗОВ.
 *
 * Все прочие проверки смотрят внутрь: база отвечает, диск не полон, тик идёт.
 * Но если Meta перестала слать вебхуки — истёк токен страницы, слетела
 * подписка после ревью приложения, сменился секрет и всё отклоняется по
 * подписи — внутри всё зелёное. Нет запросов — нет ошибок. Школа молча
 * перестаёт получать заявки, и узнаёт об этом по пустой вечерней сводке, если
 * вообще узнаёт.
 *
 * Именно так и случилось 03.09.2026 на три минуты — по моей вине, когда строгая
 * проверка подписи при пустом секрете отклонила всё. Заметил только по строке
 * в логе. Этот файл — чтобы в следующий раз заметил бот.
 *
 * Правило простое: в рабочее время (09:00–22:00 по Душанбе) входящих не было
 * дольше `inboundSilenceHours` (по умолчанию 4) — тревога владельцу и 503 в
 * /health. Ночью не считаем: тишина в три часа ночи это норма, а не поломка.
 */

const DEFAULT_SILENCE_HOURS = 4;
/** Повторная тревога не раньше чем через столько — чтобы не долбить каждый час. */
const ALERT_COOLDOWN_MS = 6 * 3_600_000;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;

type State = { silentHours: number; alerting: boolean };

let state: State = { silentHours: 0, alerting: false };
let lastAlertAt = 0;

export function inboundSilenceState(): State {
  return state;
}

async function thresholdHours(): Promise<number> {
  const raw = Number((await getSetting("inboundSilenceHours"))?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_HOURS;
}

/** Час в Душанбе для момента `at`. */
function localHour(at: Date, offset: number): number {
  return new Date(at.getTime() + offset).getUTCHours();
}

export async function checkInboundSilence(now = new Date()): Promise<void> {
  const offset = await offsetMs();
  const hour = localHour(now, offset);
  const workingHours = hour >= WORK_START_HOUR && hour < WORK_END_HOUR;

  const last = await prisma.message.findFirst({
    where: { direction: "IN" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  // Ни одного входящего за всю историю — это пустая база, а не поломка.
  if (!last) {
    state = { silentHours: 0, alerting: false };
    return;
  }

  // Ночь не считается: последнее сообщение в 22:30 и первый тик в 09:10 дали
  // бы «тишина 10 часов» и ложную тревогу каждое утро — через неделю такие
  // сообщения перестали бы читать (ревью 03.09.2026). Отсчёт — от более
  // позднего из двух: последнее входящее или начало сегодняшнего рабочего дня.
  const local = new Date(now.getTime() + offset);
  const dayStartUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), WORK_START_HOUR) - offset;
  const from = Math.max(last.createdAt.getTime(), dayStartUtc);
  const silentHours = Math.max(0, now.getTime() - from) / 3_600_000;
  const threshold = await thresholdHours();
  const alerting = workingHours && silentHours >= threshold;
  state = { silentHours: Math.round(silentHours * 10) / 10, alerting };

  if (!alerting) {
    // Ожили — следующая настоящая тишина должна бить тревогу сразу.
    lastAlertAt = 0;
    return;
  }
  if (now.getTime() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now.getTime();

  await notifyOwnerDirect(
    `🔇 Входящих сообщений нет уже ${Math.floor(silentHours)} ч в рабочее время.\n` +
      `Обычно это значит, что Instagram перестал присылать сообщения боту: истёк маркер доступа, ` +
      `слетела подписка в Meta или сменился секрет приложения. Проверьте «Настройки» и напишите боту с другого аккаунта.`
  ).catch((err) => logError("inboundWatch:alert", err));
}

/** Только для тестов. */
export function resetInboundWatch(): void {
  state = { silentHours: 0, alerting: false };
  lastAlertAt = 0;
}
