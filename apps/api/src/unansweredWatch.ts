import type { Contact, Message } from "@prisma/client";
import { prisma, getSetting, setSetting, logError } from "./db.js";
import { offsetMs } from "./dailyReport.js";
import { sendTelegramMessage, summaryChatIds } from "./telegram.js";
import { isTrivialMessage } from "./trivialMessage.js";
import { codeRelevance } from "./ai/relevance.js";
import { guardOffTopic, isSilentKind } from "./ai/offTopicGuard.js";
import { humanTakeoverEndsAt, loadHumanSilenceMs, isBotFrozen } from "./messaging/automation.js";
import { offlineHandoffSilences } from "./ai/offlineHandoff.js";
import { FOLLOW_PERSONAL_REASON } from "./profiles.js";
import { aiReply } from "./ai.js";
import { COMMENT_WAITING_OUTCOMES } from "./funnel.js";

/**
 * СТОРОЖ «БЕЗ ОТВЕТА» (владелец 09.11.2026: «сделай так, чтобы никто не
 * оставался без ответа — и в комментах, и в личных сообщениях Instagram»).
 *
 * Бот иногда молчит НАРОЧНО: Ширин только что ответила сама, после карточки
 * офлайн-курса разговор ведёт она, человек помечен знакомым. Каждое такое
 * правило разумно само по себе, но вместе они давали тишину, о которой никто не
 * знал: Ширин ответила один раз и ушла, клиент спросил ещё — и ждал вечно.
 *
 * Раз в 5 минут сторож смотрит переписки Instagram за последние сутки: последнее
 * сообщение — от клиента, старше `unansweredAfterMinutes` (15 мин), по делу (не
 * «спасибо/ок/смайлик»), и после него никто не ответил.
 *  - Молчим из-за паузы после ответа Ширин, а пауза уже кончилась
 *    (humanSilenceHours, 3 ч) — бот отвечает сам на всё, что пришло за паузу.
 *  - Любая другая причина (офлайн передан Ширин, «знакомая», клиент просил
 *    человека, пауза ещё идёт, ИИ выключен, неизвестно) — бот НЕ отвечает, а
 *    пишет Ширин и владельцу в Telegram: кто ждёт, сколько, что написал и почему
 *    бот молчит. Одно напоминание на каждое ожидание (Contact.unansweredAlertAt).
 * Комментарии: те, что остались без ответа не по нашему решению
 * (SeenComment.outcome — выключены ответы ИИ, бюджет, сбой, Ширин ведёт
 * переписку), старше `unansweredCommentMinutes` (30 мин) — в то же напоминание.
 *
 * НЕ ТРОГАЕМ: отметку «личный», поставленную вручную, и «похоже на родню»,
 * заблокированных за спам, WhatsApp и Messenger (Messenger не в приоритете),
 * людей с отобранным доступом. Ночью (22:00–09:00 по Душанбе) Telegram не
 * будим — утром придёт одно сообщение обо всех, кто ещё ждёт.
 *
 * Рубильник `unansweredWatchdogEnabled` — по умолчанию ВКЛЮЧЁН.
 */

export const UNANSWERED_WATCH_SETTING = "unansweredWatchdogEnabled";
export const UNANSWERED_AFTER_SETTING = "unansweredAfterMinutes";
export const UNANSWERED_COMMENT_AFTER_SETTING = "unansweredCommentMinutes";

const DEFAULT_AFTER_MIN = 15;
const DEFAULT_COMMENT_AFTER_MIN = 30;
/** Дальше суток не смотрим: Instagram всё равно не даст написать первым позже 24 ч. */
const LOOKBACK_MS = 24 * 3_600_000;
/** Бот отвечает сам, только пока окно Meta точно открыто (24 ч с запасом). */
const REPLY_WINDOW_MS = 23 * 3_600_000;
/** Сколько ответов бота за один тик: первый запуск может найти несколько человек сразу. */
const MAX_REPLIES_PER_TICK = 5;
const MAX_CONTACTS = 200;
const MAX_LINES = 8;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;
/** Напоминание в Telegram — не чаще раза в 15 минут. */
const NOTIFY_EVERY_MS = 15 * 60_000;
const SENT_KEY = "unansweredWatchSentAt";

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

function who(contact: Pick<Contact, "username" | "igUserId">): string {
  return contact.username ? `@${contact.username}` : contact.igUserId;
}

function minutesAgo(at: Date, now: Date): string {
  const min = Math.max(1, Math.round((now.getTime() - at.getTime()) / 60_000));
  return min < 120 ? `${min} мин` : `${Math.floor(min / 60)} ч`;
}

function clock(at: number, offset: number): string {
  const d = new Date(at + offset);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function quote(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "(фото или голосовое)";
  return `«${t.length > 120 ? `${t.slice(0, 120)}…` : t}»`;
}

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

export async function runUnansweredWatch(now = new Date()): Promise<void> {
  if ((await getSetting(UNANSWERED_WATCH_SETTING)) === "false") return;
  const silenceMs = await loadHumanSilenceMs();
  const afterMs = (await minutesSetting(UNANSWERED_AFTER_SETTING, DEFAULT_AFTER_MIN)) * 60_000;
  const commentAfterMs = (await minutesSetting(UNANSWERED_COMMENT_AFTER_SETTING, DEFAULT_COMMENT_AFTER_MIN)) * 60_000;
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const cutoff = new Date(now.getTime() - afterMs);
  const offset = await offsetMs();
  const hour = new Date(now.getTime() + offset).getUTCHours();
  const workingHours = hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
  // Не чаще раза в NOTIFY_EVERY_MS: при рекламе и выключенном помощнике иначе
  // сообщение прилетало бы каждые 5 минут. Кто не попал — попадёт в следующее
  // (отметка ожидания ставится только тем, о ком реально написали).
  const lastSent = Number((await getSetting(SENT_KEY))?.trim() ?? "");
  const mayNotify = workingHours && !(Number.isFinite(lastSent) && now.getTime() - lastSent < NOTIFY_EVERY_MS);
  const frozen = await isBotFrozen();
  const aiOn = (await getSetting("aiEnabled")) === "true";

  const candidates = await prisma.contact.findMany({
    where: {
      channel: "INSTAGRAM",
      spamBlockedAt: null,
      whatsappSavedContact: false,
      accessRevokedAt: null,
      messages: { some: { direction: "IN", createdAt: { gte: since, lte: cutoff } } },
    },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 12 } },
    take: MAX_CONTACTS,
  });

  const lines: string[] = [];
  let replies = 0;
  for (const raw of candidates) {
    const waiting = waitingOf(raw, since, cutoff);
    if (!waiting) continue;
    const { contact, pending } = waiting;
    const lastIn = pending[0];
    // Отметку «личный» вручную и «похоже на родню» не трогаем вовсе — это не клиенты.
    if (contact.personal && contact.personalReason !== FOLLOW_PERSONAL_REASON) continue;
    // Фильтр «не по делу» уже решил молчать (курьер, магазин, знакомая) — это решение, не забывчивость.
    const gateSilent = await prisma.replyGate.findFirst({
      where: { contactId: contact.id, action: "silent", createdAt: { gte: pending[pending.length - 1].createdAt } },
      select: { id: true },
    });
    if (gateSilent) continue;

    const offline = await offlineHandoffSilences(contact);
    const takeoverEnds = humanTakeoverEndsAt(contact, silenceMs);
    const askedHuman = Boolean(contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > now.getTime());
    const pauseOver = takeoverEnds !== null && takeoverEnds !== Infinity && now.getTime() >= takeoverEnds;
    const arrivedDuringPause = takeoverEnds !== null && lastIn.createdAt.getTime() < takeoverEnds;
    const texts = pending.map((m) => m.text?.trim()).filter((t): t is string => Boolean(t)).reverse();

    // ПАУЗА КОНЧИЛАСЬ — ОТВЕЧАЕТ БОТ. Сообщение пришло, пока Ширин вела
    // разговор, она не ответила, а пауза уже прошла: дальше ждать некого.
    if (
      pauseOver && arrivedDuringPause && !contact.personal && !offline && !askedHuman && !frozen && aiOn &&
      texts.length > 0 && now.getTime() - lastIn.createdAt.getTime() < REPLY_WINDOW_MS && replies < MAX_REPLIES_PER_TICK
    ) {
      if (!(await claim(contact.id, lastIn.createdAt, now))) continue;
      replies++;
      try {
        await aiReply(contact, texts.join("\n"));
      } catch (err) {
        logError("unansweredWatch:reply", err);
      }
      const answered = await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "OUT", createdAt: { gt: lastIn.createdAt } },
        select: { id: true },
      });
      if (!answered) lines.push(`• ${who(contact)} — ${minutesAgo(lastIn.createdAt, now)}: ${quote(lastIn.text)} — бот попробовал ответить после паузы, но не смог`);
      continue;
    }

    if (!mayNotify) continue; // ночью Telegram не будим — утром напомним
    let reason: string;
    if (offline) reason = "офлайн-курс: после карточки разговор ведёте вы";
    else if (contact.personal) reason = "отмечен знакомым (вы подписаны) — если это клиент, снимите отметку в «Ученицы»";
    else if (askedHuman) reason = "просил(а) живого человека";
    else if (takeoverEnds !== null && !pauseOver) {
      reason = takeoverEnds === Infinity
        ? "вы ведёте переписку сами, бот выключен для этого человека"
        : `вы недавно отвечали сами — бот молчит до ${clock(takeoverEnds, offset)}, потом ответит сам`;
    } else if (frozen) reason = "бот на экстренной паузе";
    else if (!aiOn) reason = "ответы помощника выключены";
    else reason = "бот не ответил, причина неизвестна — загляните в «Журнал»";
    if (!(await claim(contact.id, lastIn.createdAt, now))) continue;
    lines.push(`• ${who(contact)} — ${minutesAgo(lastIn.createdAt, now)}: ${quote(lastIn.text)} — ${reason}`);
  }

  const commentLines = mayNotify ? await waitingComments(now, since, new Date(now.getTime() - commentAfterMs)) : [];
  if (lines.length === 0 && commentLines.length === 0) return;
  await setSetting(SENT_KEY, String(now.getTime()));
  await notifyWaiting(lines, commentLines);
}

const COMMENT_REASON: Record<string, string> = {
  waiting_human: "вы сейчас ведёте переписку с этим человеком",
  ai_off: "ответы помощника под комментариями выключены",
  no_keys: "у помощника нет ключа ИИ",
  budget: "кончился дневной лимит ИИ, человеку ушло «напишите чуть позже»",
  ai_error: "сбой ИИ или Instagram",
};

async function waitingComments(now: Date, since: Date, cutoff: Date): Promise<string[]> {
  const rows = await prisma.seenComment.findMany({
    where: { outcome: { in: [...COMMENT_WAITING_OUTCOMES] }, alertedAt: null, createdAt: { gte: since, lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
  const contacts = ids.length
    ? await prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, igUserId: true } })
    : [];
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const lines: string[] = [];
  for (const row of rows) {
    // Ответили потом в директ (Ширин сама или бот по другому поводу) — уже не ждёт.
    const answered = row.contactId
      ? await prisma.message.findFirst({
          where: { contactId: row.contactId, direction: "OUT", createdAt: { gt: row.createdAt } },
          select: { id: true },
        })
      : null;
    const claimed = await prisma.seenComment.updateMany({ where: { commentId: row.commentId, alertedAt: null }, data: { alertedAt: now } });
    if (claimed.count === 0 || answered) continue;
    const contact = row.contactId ? byId.get(row.contactId) : undefined;
    lines.push(
      `• ${contact ? who(contact) : "человек"} — ${minutesAgo(row.createdAt, now)}: ${quote(row.text)} — ${COMMENT_REASON[row.outcome ?? ""] ?? "без ответа"}`,
    );
  }
  return lines;
}

function capped(lines: string[]): string[] {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `…и ещё ${lines.length - MAX_LINES}`] : lines;
}

/** Ширин и владельцу (чат сводок): это не техника, а живые клиенты. */
async function notifyWaiting(dmLines: string[], commentLines: string[]): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  const recipients = await summaryChatIds();
  if (recipients.length === 0) return;
  const parts: string[] = [];
  if (dmLines.length) parts.push("⏳ Ждут ответа в директе Instagram:", ...capped(dmLines));
  if (commentLines.length) parts.push(...(parts.length ? [""] : []), "💬 Комментарии без ответа:", ...capped(commentLines));
  parts.push("", "Ответьте, пожалуйста, в Instagram. Об одном ожидании напоминаю один раз.");
  const text = parts.join("\n");
  for (const chatId of recipients) {
    await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("unansweredWatch:notify", err));
  }
}
