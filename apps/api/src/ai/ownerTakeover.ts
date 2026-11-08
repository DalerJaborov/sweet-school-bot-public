import type { Contact } from "@prisma/client";
import { prisma, getSetting, logError } from "../db.js";
import { looksLikeAccessRequest } from "../course/recovery.js";
import { isPureThanks } from "./reactions.js";

/**
 * УМНЫЙ ПЕРЕХВАТ ХОЗЯЙКИ (владелец 08.11.2026).
 *
 * Раньше любое ручное сообщение Ширин (из приложения Instagram или WhatsApp) ставило
 * contact.humanTakenOverAt, и бот молчал с этим человеком ВЕЧНО, пока владелец не
 * снимет паузу руками. Слова владельца: «если Ширин сама ответила, бот больше никогда
 * не включается — это ошибка: человек захочет восстановить доступ, а Ширин не отвечает».
 *
 * Теперь пауза — не выключатель, а решение, которое принимается на каждое входящее:
 *  1) пока Ширин живо ведёт разговор (последняя её реплика не старше `liveWindowMin`),
 *     бот молчит;
 *  2) но клиентка не ждёт дольше `idleReplyMin`: если Ширин не ответила на её новое
 *     сообщение за это время — бот отвечает сам. Ответ готовится в обычной очереди
 *     (PendingAiReply) с отложенным временем, а не новым механизмом;
 *  3) безопасные запросы (вернуть доступ купившей, чистое «спасибо») обслуживаются
 *     сразу, перехват остаётся;
 *  4) через `expireHours` после последней ручной реплики пауза снимается совсем;
 *  5) новая ручная реплика Ширин включает паузу заново (handleEcho / мост WhatsApp
 *     пишут humanTakenOverAt, пока он пуст — а мы его чистим при каждом возврате бота).
 *
 * Рубильник `smartTakeoverEnabled`: "false" возвращает старое «молчим, пока не снимут».
 * Числа лежат в настройках, значения по умолчанию:
 *  - 25 минут «живого окна» и 12 минут терпения — предложение, меняются без выкатки;
 *  - 24 часа — окно, в котором Instagram разрешает писать клиенту после его
 *    последнего сообщения; дольше «тихая пауза» смысла не имеет.
 */

export type TakeoverConfig = {
  enabled: boolean;
  liveWindowMin: number;
  idleReplyMin: number;
  expireHours: number;
};

export const TAKEOVER_DEFAULTS = { liveWindowMin: 25, idleReplyMin: 12, expireHours: 24 } as const;

async function numSetting(key: string, fallback: number): Promise<number> {
  const raw = Number((await getSetting(key))?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export async function loadTakeoverConfig(): Promise<TakeoverConfig> {
  return {
    enabled: (await getSetting("smartTakeoverEnabled")) !== "false",
    liveWindowMin: await numSetting("takeoverLiveWindowMin", TAKEOVER_DEFAULTS.liveWindowMin),
    idleReplyMin: await numSetting("takeoverIdleReplyMin", TAKEOVER_DEFAULTS.idleReplyMin),
    expireHours: await numSetting("takeoverExpireHours", TAKEOVER_DEFAULTS.expireHours),
  };
}

export type TakeoverDecision =
  | { action: "hold"; until: Date | null }
  | { action: "answer"; why: "expired" | "idle" | "cold" | "safe_intent" };

/** Безопасно ли ответить сразу, даже если Ширин на связи. */
export function isSafeIntent(text: string | null | undefined, hasPurchase: boolean): boolean {
  const t = text?.trim();
  if (!t) return false;
  // Просьбу вернуть доступ бот может выполнить только для купившей: это детерминированная
  // выдача по данным (course/recovery.ts), без свободного разговора.
  if (hasPurchase && looksLikeAccessRequest(t)) return true;
  // Чистое «спасибо» — реакция или одно тёплое слово, ничего не обещаем.
  return isPureThanks(t);
}

/** Чистое решение без обращений к базе — удобно проверять тестами. */
export function decideTakeover(input: {
  config: TakeoverConfig;
  /** Когда Ширин в последний раз писала вручную (или когда поставлена пауза, если реплик нет). */
  anchor: Date;
  /** Когда пришло сообщение клиентки, на которое решаем. */
  incomingAt: Date;
  safeIntent: boolean;
  now: Date;
}): TakeoverDecision {
  const { config, anchor, incomingAt, safeIntent, now } = input;
  if (!config.enabled) return { action: "hold", until: null };
  if (now.getTime() - anchor.getTime() >= config.expireHours * 3_600_000) return { action: "answer", why: "expired" };
  if (safeIntent) return { action: "answer", why: "safe_intent" };
  const liveUntil = anchor.getTime() + config.liveWindowMin * 60_000;
  const idleUntil = incomingAt.getTime() + config.idleReplyMin * 60_000;
  const until = Math.min(liveUntil, idleUntil);
  if (until > now.getTime()) return { action: "hold", until: new Date(until) };
  return { action: "answer", why: liveUntil <= idleUntil ? "cold" : "idle" };
}

type TakeoverContact = Pick<Contact, "id" | "humanTakenOverAt">;

/** Время последней ручной реплики хозяйки; если реплик в базе нет — момент постановки паузы. */
export async function ownerAnchor(contact: TakeoverContact): Promise<Date | null> {
  const last = await prisma.message.findFirst({
    where: { contactId: contact.id, direction: "OUT", byHuman: true },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return last?.createdAt ?? contact.humanTakenOverAt ?? null;
}

/** Снять постоянный перехват (в базе). Мост WhatsApp снимает свой флаг отдельно (whatsapp/worker.ts). */
export async function releaseTakeover(contactId: string): Promise<void> {
  await prisma.contact.update({ where: { id: contactId }, data: { humanTakenOverAt: null, humanTakeoverMid: null } });
}

/**
 * Решение по ОДНОМУ входящему сообщению для контакта, у которого стоит перехват.
 * Побочный эффект: ответ по причинам expired/idle/cold снимает перехват в базе
 * (новая реплика Ширин поставит его заново); safe_intent перехват не трогает.
 */
export async function resolveTakeover(
  contact: TakeoverContact,
  incoming: { text: string | null; at: Date },
  now = new Date(),
): Promise<TakeoverDecision> {
  const config = await loadTakeoverConfig();
  const anchor = await ownerAnchor(contact);
  if (!config.enabled || !anchor) return { action: "hold", until: null };
  const hasPurchase =
    incoming.text && looksLikeAccessRequest(incoming.text)
      ? (await prisma.purchase.count({ where: { contactId: contact.id } })) > 0
      : false;
  const decision = decideTakeover({
    config,
    anchor,
    incomingAt: incoming.at,
    safeIntent: isSafeIntent(incoming.text, hasPurchase),
    now,
  });
  if (decision.action === "answer" && decision.why !== "safe_intent") {
    await releaseTakeover(contact.id).catch((err) => logError("ownerTakeover:release", err));
  }
  return decision;
}

/** Откладывает ответ до момента, когда бот вправе его дать (очередь aiReplyRetry.ts). */
export async function scheduleHeldReply(contactId: string, text: string, until: Date, snapshotAt: Date): Promise<void> {
  if (!text) return;
  const exists = await prisma.pendingAiReply.findFirst({ where: { contactId, snapshotAt } });
  if (exists) return;
  await prisma.pendingAiReply
    .create({ data: { contactId, text, snapshotAt, nextAttemptAt: until } })
    .catch((err) => logError("ownerTakeover:schedule", err));
}
