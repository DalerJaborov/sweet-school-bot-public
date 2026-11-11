import crypto from "node:crypto";
import { canRetryMetaFailure } from "./messaging/metaErrors.js";
import { prisma, logError } from "./db.js";

export type InboxEvent = {
  channel: "INSTAGRAM" | "MESSENGER";
  selfId?: string;
  kind: "message" | "comment";
  event: Record<string, unknown>;
};

export function inboxKey(input: InboxEvent): string {
  const message = input.event.message as { mid?: string; is_echo?: boolean } | undefined;
  const value = input.event.value as { id?: string; comment_id?: string } | undefined;
  const identity = input.kind === "message" && message?.mid
    ? `${message.is_echo ? "echo" : "message"}:${message.mid}`
    : input.kind === "comment" && (value?.id || value?.comment_id)
      ? `comment:${value.id || value.comment_id}`
      : `hash:${crypto.createHash("sha256").update(JSON.stringify(input.event)).digest("hex")}`;
  return `${input.channel}:${input.selfId ?? ""}:${identity}`;
}

/** Commit the whole batch before acknowledging Meta. Duplicate delivery is a no-op. */
export async function acceptWebhookEvents(events: InboxEvent[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const event of events) {
      const eventKey = inboxKey(event);
      await tx.webhookInbox.upsert({ where: { eventKey }, update: {}, create: { eventKey, payload: JSON.stringify(event) } });
    }
  });
}

const LEASE_MS = 5 * 60_000;
let scanning = false;
let rescan = false;

/**
 * At-least-once processing. A crash after remote send can still require human reconciliation.
 *
 * ЗАХВАТ НЕ ЖДЁТ ОБРАБОТКИ (11.11.2026). Раньше один флаг держал весь проход —
 * вместе с ожиданием ответа бота (окно дебаунса + генерация). Второе сообщение
 * того же человека, пришедшее через 2 секунды, ждало в очереди, пока бот не
 * ответит на первое, и получало СВОЙ отдельный ответ: пачка из трёх пузырей
 * давала два-три ответа. Теперь флаг держит только выборку и захват строк
 * (захват атомарный — updateMany по состоянию), а обработчики идут параллельно:
 * новое сообщение сразу попадает в то же окно дебаунса. Пришёл вебхук во время
 * выборки — проход повторяется (rescan), ничего не теряется.
 */
/**
 * ПОТОЛОК ПАРАЛЛЕЛЬНОСТИ (ревью 11.11.2026). Без него всплеск (реклама, 30 человек
 * за минуту) запускал 30 обработчиков сразу: 30 ходов Gemini, 30 записей в одну
 * SQLite — таймауты и «database is locked». Шесть — с запасом на пачку из 3–4
 * пузырей одного человека плюс ещё пару собеседников: второй пузырь по-прежнему
 * берётся в работу, пока первый ждёт окна дебаунса. Остальное ждёт в очереди и
 * берётся, как только освобождается место (не теряется: строки в базе).
 */
export const MAX_PARALLEL_HANDLERS = 6;
let active = 0;
/** Выборку обрезал потолок — есть строки, которые ждут свободного места. */
let backlog = false;

export async function processWebhookInbox(handle: (event: InboxEvent) => Promise<void>): Promise<void> {
  if (scanning) {
    rescan = true;
    return;
  }
  scanning = true;
  const inFlight: Promise<void>[] = [];
  try {
    do {
      rescan = false;
      const free = MAX_PARALLEL_HANDLERS - active;
      if (free <= 0) {
        // Мест нет — освободившийся обработчик сам запустит новый проход.
        backlog = true;
        break;
      }
      const now = new Date();
      const eligible = { OR: [
        { state: "PENDING", nextRunAt: { lte: now } },
        { state: "PROCESSING", leaseUntil: { lte: now } },
      ] };
      const rows = await prisma.webhookInbox.findMany({ where: eligible, orderBy: { createdAt: "asc" }, take: free });
      if ((rows ?? []).length >= free) backlog = true;
      for (const row of rows ?? []) {
        // Захват — здесь, до запуска обработчика: повторная выборка его уже не увидит.
        const claim = await prisma.webhookInbox.updateMany({
          where: { id: row.id, ...eligible },
          data: { state: "PROCESSING", leaseUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 } },
        });
        if (claim.count !== 1) continue;
        active++;
        inFlight.push(
          runRow(row, handle).finally(() => {
            active--;
            if (!backlog) return;
            backlog = false;
            void processWebhookInbox(handle).catch((err) => logError("webhookInbox:backlog", err));
          }),
        );
      }
    } while (rescan);
  } finally {
    scanning = false;
  }
  await Promise.all(inFlight);
}

/** Для тестов: сколько обработчиков сейчас в работе. */
export function activeWebhookHandlers(): number {
  return active;
}

type InboxRow = { id: string; payload: string; attempts: number };

async function runRow(row: InboxRow, handle: (event: InboxEvent) => Promise<void>): Promise<void> {
  const heartbeat = setInterval(() => {
    void prisma.webhookInbox.updateMany({ where: { id: row.id, state: "PROCESSING" }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch((err) => logError("webhookInbox:lease", err));
  }, 60_000);
  heartbeat.unref?.();
  try {
    await handle(JSON.parse(row.payload) as InboxEvent);
    await prisma.webhookInbox.update({ where: { id: row.id }, data: { state: "DONE", leaseUntil: null, lastError: null } });
  } catch (err) {
    const terminal = row.attempts + 1 >= 8 || !canRetryMetaFailure(err);
    await prisma.webhookInbox.update({ where: { id: row.id }, data: {
      state: terminal ? "FAILED" : "PENDING", leaseUntil: null,
      nextRunAt: new Date(Date.now() + Math.min(30_000 * 2 ** row.attempts, 30 * 60_000)),
      lastError: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000),
    } });
    logError(terminal ? "webhookInbox:gaveUp" : "webhookInbox:retry", err);
  } finally { clearInterval(heartbeat); }
}
