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
let running = false;

/** At-least-once processing. A crash after remote send can still require human reconciliation. */
export async function processWebhookInbox(handle: (event: InboxEvent) => Promise<void>): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const eligible = { OR: [
      { state: "PENDING", nextRunAt: { lte: now } },
      { state: "PROCESSING", leaseUntil: { lte: now } },
    ] };
    const rows = await prisma.webhookInbox.findMany({ where: eligible, orderBy: { createdAt: "asc" }, take: 10 });
    await Promise.all(rows.map(async (row) => {
      const leaseUntil = new Date(Date.now() + LEASE_MS);
      const claim = await prisma.webhookInbox.updateMany({ where: { id: row.id, ...eligible }, data: { state: "PROCESSING", leaseUntil, attempts: { increment: 1 } } });
      if (claim.count !== 1) return;
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
    }));
  } finally { running = false; }
}
