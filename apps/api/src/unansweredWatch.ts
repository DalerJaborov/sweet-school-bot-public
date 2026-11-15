import type { Contact, Message } from "@prisma/client";
import { prisma, getSetting, logError } from "./db.js";
import { isTrivialMessage } from "./trivialMessage.js";
import { codeRelevance } from "./ai/relevance.js";
import { guardOffTopic, isSilentKind } from "./ai/offTopicGuard.js";
import { humanTakeoverEndsAt, loadHumanSilenceMs, isBotFrozen } from "./messaging/automation.js";
import { recordNoReply } from "./messaging/noReply.js";
import { sendKind } from "./notify.js";
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
/** То, что ждало ещё до старта процесса (выкатка, рестарт), — только последние 6 ч. */
const FIRST_RUN_WINDOW_MS = 6 * 3_600_000;
let watchStartedAt = Date.now();
/** Только для тестов: момент «старта процесса». */
export function setWatchStartedAt(ms: number): void {
  watchStartedAt = ms;
}
const NEWLINE = String.fromCharCode(10);
/** Сколько ответов бота за один тик: первый запуск может найти несколько человек сразу. */
const MAX_REPLIES_PER_TICK = 5;
const MAX_CONTACTS = 500;

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

/**
 * Одно решение на ожидание: занимаем отметку атомарно (два тика не задвоят) и
 * ТЕМ ЖЕ запросом проверяем, что после этого входящего в переписке ничего не
 * появилось (ответ Ширин, бота, новое сообщение клиента) — иначе двойной ответ.
 */
async function claim(contactId: string, lastInAt: Date, now: Date): Promise<boolean> {
  const res = await prisma.contact.updateMany({
    where: {
      id: contactId,
      OR: [{ unansweredAlertAt: null }, { unansweredAlertAt: { lt: lastInAt } }],
      messages: { none: { createdAt: { gt: lastInAt } } },
    },
    data: { unansweredAlertAt: now },
  });
  return (res?.count ?? 0) > 0;
}

/** Ответ сторожа упал (Meta 500, сеть) — вернуть отметку, чтобы следующий тик попробовал снова; не больше MAX_ATTEMPTS. */
const MAX_ATTEMPTS = 3;
async function releaseAfterFailure(contact: Contact, lastInAt: Date, claimedAt: Date): Promise<void> {
  try {
    const failures = await prisma.replyGate.count({
      where: { contactId: contact.id, reason: { startsWith: "send_failed:" }, createdAt: { gte: lastInAt } },
    });
    if ((failures ?? 0) >= MAX_ATTEMPTS) return;
    await prisma.contact.updateMany({
      where: { id: contact.id, unansweredAlertAt: claimedAt },
      data: { unansweredAlertAt: contact.unansweredAlertAt },
    });
  } catch (err) {
    logError("unansweredWatch:release", err);
  }
}

/** После последнего ответа пришло фото или чек (в очереди, на проверке у владельца): текстом бот не гадает. */
async function receiptOrPhotoPending(contactId: string, pending: Message[]): Promise<boolean> {
  if (pending.some((m) => !m.text?.trim() && !m.payload)) return true;
  const since = pending[pending.length - 1].createdAt;
  const receipt = await prisma.receiptCheck.findFirst({
    where: { contactId, createdAt: { gte: since } },
    select: { id: true },
  });
  return Boolean(receipt);
}

/**
 * КЛИЕНТ САМ ПОПРОСИЛ ЧЕЛОВЕКА (правило владельца): бот к нему сам не
 * возвращается — сторож один раз напоминает Ширин. «Сейчас уточню» бота — другое:
 * там после тишины бот отвечает сам. Просьба открыта, пока Ширин не ответила.
 */
async function askedHumanOpen(contact: Contact): Promise<boolean> {
  const at = contact.humanRequestedAt;
  if (!at) return false;
  const human = await prisma.message.findFirst({
    where: { contactId: contact.id, direction: "OUT", byHuman: true, createdAt: { gte: at } },
    select: { id: true },
  });
  if (human) return false;
  const trace = await prisma.replyGate.findFirst({
    where: {
      contactId: contact.id,
      reason: { startsWith: "asked_human:" },
      createdAt: { gte: new Date(at.getTime() - 60_000) },
    },
    select: { id: true },
  });
  if (trace) return true;
  // Просьбы до журнала решений: входящее прямо перед отметкой — «позовите человека».
  const before = await prisma.message.findMany({
    where: { contactId: contact.id, direction: "IN", createdAt: { gte: new Date(at.getTime() - 15 * 60_000), lte: at } },
    select: { text: true },
  });
  return (before ?? []).some((m) => Boolean(m.text) && guardOffTopic(m.text as string)?.kind === "wants_human");
}

async function remindShirinOnce(contact: Contact, lastIn: Message): Promise<void> {
  const at = contact.humanRequestedAt as Date;
  const reminded = await prisma.replyGate.findFirst({
    where: { contactId: contact.id, reason: { startsWith: "asked_human_reminded:" }, createdAt: { gte: at } },
    select: { id: true },
  });
  if (reminded) return;
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const last = (lastIn.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const lines = [`🙋 ${who} просил(а) живого человека и всё ещё ждёт ответа.`];
  if (last) lines.push(`Последнее: «${last}»`);
  lines.push("Бот сам не отвечает — ответьте, пожалуйста.");
  await sendKind("human", lines.join(NEWLINE)).catch((err) => logError("unansweredWatch:remind", err));
  await recordNoReply(contact, "asked_human_reminded", lastIn.text);
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

  // Сначала — люди, которые писали последними (раньше take без порядка мог пропускать
  // часть контактов при большом наплыве). Один запрос по входящим, по человеку — одно.
  const recent = await prisma.message.findMany({
    where: {
      direction: "IN",
      createdAt: { gte: since, lte: cutoff },
      contact: {
        channel: { in: WATCHED_CHANNELS },
        spamBlockedAt: null,
        whatsappSavedContact: false,
        accessRevokedAt: null,
        personal: false,
      },
    },
    orderBy: { createdAt: "desc" },
    distinct: ["contactId"],
    select: { contactId: true },
    take: MAX_CONTACTS,
  });
  const ids = (recent ?? []).map((r) => r.contactId);
  if (ids.length === 0) return;
  const rank = new Map(ids.map((id, i) => [id, i]));
  const candidates = (
    (await prisma.contact.findMany({
      where: { id: { in: ids } },
      include: { messages: { orderBy: { createdAt: "desc" }, take: 12 } },
    })) ?? []
  ).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  let replies = 0;
  for (const raw of candidates) {
    if (replies >= MAX_REPLIES_PER_TICK) break;
    const waiting = waitingOf(raw, since, cutoff);
    if (!waiting) continue;
    const { contact, pending } = waiting;
    const lastIn = pending[0];
    // «Личный» — вручную или «знакомые» (на них подписана Ширин) — это не клиенты.
    if (contact.personal) continue;
    const waitedMs = now.getTime() - lastIn.createdAt.getTime();
    // Сразу после выкатки (рестарта) не отвечаем на то, что ждёт с прошлого дня: окно 6 ч, не 23.
    const windowMs = lastIn.createdAt.getTime() < watchStartedAt ? FIRST_RUN_WINDOW_MS : REPLY_WINDOW_MS;
    if (waitedMs >= windowMs) continue;

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

    // Фото или чек после последнего ответа: без картинки бот ответил бы «чек не вижу».
    if (await receiptOrPhotoPending(contact.id, pending)) {
      if (await claim(contact.id, lastIn.createdAt, now)) await recordNoReply(contact, "media_only", lastIn.text);
      continue;
    }
    // Клиент просил человека — бот сам не возвращается, Ширин напоминаем один раз.
    if (await askedHumanOpen(contact)) {
      if (await claim(contact.id, lastIn.createdAt, now)) await remindShirinOnce(contact, lastIn);
      continue;
    }

    if (!(await claim(contact.id, lastIn.createdAt, now))) continue;
    const texts = pending
      .map((m) => m.text?.trim())
      .filter((t): t is string => Boolean(t))
      .reverse();
    replies++;
    try {
      // Если и сейчас ответа не будет, aiReply сам запишет причину в журнал.
      await aiReply(contact, texts.join(NEWLINE), [], [], { waitedMs });
    } catch (err) {
      logError("unansweredWatch:reply", err);
      await releaseAfterFailure(contact, lastIn.createdAt, now);
    }
  }
}
