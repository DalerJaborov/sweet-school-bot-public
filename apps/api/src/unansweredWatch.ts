import type { Contact, Message } from "@prisma/client";
import { prisma, getSetting, logError } from "./db.js";
import { isTrivialMessage } from "./trivialMessage.js";
import { codeRelevance } from "./ai/relevance.js";
import { guardOffTopic, isSilentKind } from "./ai/offTopicGuard.js";
import { humanTakeoverEndsAt, loadHumanSilenceMs, isBotFrozen } from "./messaging/automation.js";
import { recordNoReply } from "./messaging/noReply.js";
import { offlineHandoffSilences } from "./ai/offlineHandoff.js";
import { aiReply } from "./ai.js";

/**
 * СТОРОЖ «БЕЗ ОТВЕТА» (владелец 09.11.2026: «сделай так, чтобы никто не
 * оставался без ответа»). С 11.11.2026 — БЕЗ СООБЩЕНИЙ В TELEGRAM.
 *
 * Раз в 5 минут сторож смотрит переписки Instagram и Messenger за последние
 * сутки: последнее сообщение — от клиента, старше `unansweredAfterMinutes`
 * (15 мин), по делу (не «спасибо/ок/смайлик»), и после него никто не ответил.
 * Если временная тишина уже кончилась и молчать никто не решал — бот отвечает
 * сам на всё, что накопилось.
 *
 * АУДИТ 15.11.2026 (7 дней прода): 60 человек ждали после паузы Ширин и 24 —
 * после быстрого ответа на ответ бота. Сторож их не видел, потому что смотрел
 * только на одну тишину — паузу после ответа Ширин (humanTakeoverEndsAt), только
 * Instagram и только на сообщения, пришедшие ВО ВРЕМЯ этой паузы. Мимо шли:
 *  — «сейчас уточню и напишу вам» и «позову Ширин» (humanSilencedUntil, 1 ч):
 *    всё, что клиент писал в этот час, не подбирал никто и никогда;
 *  — реакция Ширин (10 мин тишины) — то же;
 *  — Messenger, хотя пауза там такая же временная (automation.ts);
 *  — сообщения после конца паузы, на которые бот промолчал из-за сбоя, гонки
 *    эха или рестарта: «пришло не во время паузы» — значит не моё.
 * Теперь правило одно: тишина кончилась, ответа нет, решения «молчать» в
 * журнале нет (ReplyGate action=silent, messaging/noReply.ts) — отвечает бот.
 * Всё, что бот решает не отвечать, пишется в журнал, поэтому сторож отличает
 * решение от потери, а не гадает.
 *
 * НЕ ТРОГАЕМ: отметку «личный» (ручную и «знакомые»), заблокированных за спам,
 * WhatsApp и сайт, людей с отобранным доступом, офлайн, переданный Ширин, ход,
 * который ещё в работе (очередь повторов ИИ, необработанный вебхук).
 *
 * Рубильник `unansweredWatchdogEnabled` — по умолчанию ВКЛЮЧЁН.
 */

export const UNANSWERED_WATCH_SETTING = "unansweredWatchdogEnabled";
export const UNANSWERED_AFTER_SETTING = "unansweredAfterMinutes";

const DEFAULT_AFTER_MIN = 15;
/** Дальше суток не смотрим: Instagram всё равно не даст написать первым позже 24 ч. */
const LOOKBACK_MS = 24 * 3_600_000;
/** Бот отвечает сам, только пока окно Meta точно открыто (24 ч с запасом). */
const REPLY_WINDOW_MS = 23 * 3_600_000;
/** Сколько ответов бота за один тик: первый запуск может найти несколько человек сразу. */
const MAX_REPLIES_PER_TICK = 5;
const MAX_CONTACTS = 200;

async function minutesSetting(key: string, fallback: number): Promise<number> {
  const raw = Number((await getSetting(key))?.trim());
  return Number.isFinite(raw) && raw >= 1 ? raw : fallback;
}

/**
 * «Пустое подтверждение» — спасибо, ок, хоб, смайлик: ответа не требует.
 * Новых слов здесь нет: пустяк по общему списку (trivialMessage.ts), но
 * приветствие, «+» с рекламы и «???» — это заход клиента (relevance.ts решает их
 * как greeting/unclear), на них молчать нельзя. «Пустите бесплатно» — нарочное
 * молчание (offTopicGuard).
 */
export function needsAnswer(m: Pick<Message, "text" | "payload">): boolean {
  if (m.payload) return true; // нажал кнопку, а ничего не пришло
  const text = m.text?.trim();
  if (!text) return true; // фото/голос без расшифровки — возможно чек
  const verdict = guardOffTopic(text);
  if (verdict && isSilentKind(verdict.kind)) return false;
  if (!isTrivialMessage(text)) return true;
  const rel = codeRelevance(text);
  return rel !== null && rel.cls !== "empty";
}

type Waiting = {
  contact: Contact;
  /** Входящие после последнего ответа — от новых к старым. */
  pending: Message[];
};

/** Последнее слово в переписке — за клиентом, и он ждёт дольше порога. */
function waitingOf(contact: Contact & { messages: Message[] }, since: Date, cutoff: Date): Waiting | null {
  const pending: Message[] = [];
  for (const m of contact.messages) {
    if (m.direction !== "IN") break;
    pending.push(m);
  }
  const lastIn = pending[0];
  if (!lastIn || lastIn.createdAt > cutoff || lastIn.createdAt < since) return null;
  if (contact.unansweredAlertAt && contact.unansweredAlertAt >= lastIn.createdAt) return null;
  if (!pending.some(needsAnswer)) return null;
  const { messages: _messages, ...plain } = contact;
  return { contact: plain as Contact, pending };
}

/** Одно напоминание на ожидание: занимаем отметку атомарно (два тика не задвоят). */
async function claim(contactId: string, lastInAt: Date, now: Date): Promise<boolean> {
  const res = await prisma.contact.updateMany({
    where: { id: contactId, OR: [{ unansweredAlertAt: null }, { unansweredAlertAt: { lt: lastInAt } }] },
    data: { unansweredAlertAt: now },
  });
  return res.count > 0;
}

/** Каналы, где тишина после Ширин временная и сторож отвечает сам (WhatsApp — вручную, automation.ts). */
const WATCHED_CHANNELS = ["INSTAGRAM", "MESSENGER"];

/**
 * Когда кончается временная тишина бота: пауза после живого ответа Ширин или
 * «ждём человека» (клиент просил, бот сказал «уточню», реакция Ширин).
 * null — тишины нет; Infinity — бессрочная (не наш случай: WhatsApp).
 */
export function silenceEndsAt(contact: Contact, silenceMs: number): number | null {
  const takeover = humanTakeoverEndsAt(contact, silenceMs);
  const requested = contact.humanSilencedUntil?.getTime() ?? null;
  if (takeover === null) return requested;
  if (requested === null) return takeover;
  return Math.max(takeover, requested);
}

/** Ход по этим сообщениям ещё в работе: очередь повторов ИИ или вебхук не дообработан. */
async function stillInProgress(contactId: string, pending: Message[]): Promise<boolean> {
  if (await prisma.pendingAiReply.findFirst({ where: { contactId }, select: { id: true } })) return true;
  const mids = pending.map((m) => m.mid).filter((mid): mid is string => Boolean(mid));
  if (mids.length === 0) return false;
  const row = await prisma.webhookInbox.findFirst({
    where: {
      state: { in: ["PENDING", "PROCESSING"] },
      OR: mids.map((mid) => ({ eventKey: { endsWith: `:message:${mid}` } })),
    },
    select: { id: true },
  });
  return Boolean(row);
}

export async function runUnansweredWatch(now = new Date()): Promise<void> {
  if ((await getSetting(UNANSWERED_WATCH_SETTING)) === "false") return;
  const silenceMs = await loadHumanSilenceMs();
  const afterMs = (await minutesSetting(UNANSWERED_AFTER_SETTING, DEFAULT_AFTER_MIN)) * 60_000;
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const cutoff = new Date(now.getTime() - afterMs);
  const frozen = await isBotFrozen();
  const aiOn = (await getSetting("aiEnabled")) === "true";
  // Бот не отвечает на экстренной паузе и при выключенном помощнике — и
  // сообщать об этом больше некому: «ждут» видно в панели.
  if (frozen || !aiOn) return;

  const candidates = await prisma.contact.findMany({
    where: {
      channel: { in: WATCHED_CHANNELS },
      spamBlockedAt: null,
      whatsappSavedContact: false,
      accessRevokedAt: null,
      messages: { some: { direction: "IN", createdAt: { gte: since, lte: cutoff } } },
    },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 12 } },
    take: MAX_CONTACTS,
  });

  let replies = 0;
  for (const raw of candidates) {
    if (replies >= MAX_REPLIES_PER_TICK) break;
    const waiting = waitingOf(raw, since, cutoff);
    if (!waiting) continue;
    const { contact, pending } = waiting;
    const lastIn = pending[0];
    // «Личный» — вручную или «знакомые» (на них подписана Ширин) — это не клиенты.
    if (contact.personal) continue;
    if (now.getTime() - lastIn.createdAt.getTime() >= REPLY_WINDOW_MS) continue;

    // Тишина ещё идёт — Ширин ведёт разговор или клиент ждёт человека. Кончится — ответим.
    const ends = silenceEndsAt(contact, silenceMs);
    if (ends === Infinity || (ends !== null && now.getTime() < ends)) continue;

    // На ПОСЛЕДНЕЕ сообщение бот уже РЕШИЛ молчать (фильтр «не по делу», [NO_REPLY], реакция,
    // офлайн у Ширин) — это решение, не забывчивость. «Ждём человека» (wait) не мешает.
    // Считаем от последнего входящего: реакция на «рахмат» не должна глушить вопрос, заданный после.
    const decided = await prisma.replyGate.findFirst({
      where: { contactId: contact.id, action: "silent", createdAt: { gte: lastIn.createdAt } },
      select: { id: true },
    });
    if (decided) continue;
    if (await offlineHandoffSilences(contact)) continue;
    if (await stillInProgress(contact.id, pending)) continue;

    if (!(await claim(contact.id, lastIn.createdAt, now))) continue;
    const texts = pending
      .map((m) => m.text?.trim())
      .filter((t): t is string => Boolean(t))
      .reverse();
    if (texts.length === 0) {
      // Только фото/файл: ссылка на вложение уже протухла, а чек разбирает своя очередь.
      await recordNoReply(contact, "media_only", null);
      continue;
    }
    replies++;
    try {
      // Если и сейчас ответа не будет, aiReply сам запишет причину в журнал.
      await aiReply(contact, texts.join("\n"));
    } catch (err) {
      logError("unansweredWatch:reply", err);
    }
  }
}
