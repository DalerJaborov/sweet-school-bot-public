import type { Contact, Message } from "@prisma/client";
import { prisma, getSetting, logError } from "./db.js";
import { isTrivialMessage } from "./trivialMessage.js";
import { codeRelevance } from "./ai/relevance.js";
import { guardOffTopic, isSilentKind } from "./ai/offTopicGuard.js";
import { humanTakeoverEndsAt, loadHumanSilenceMs, isBotFrozen } from "./messaging/automation.js";
import { offlineHandoffSilences } from "./ai/offlineHandoff.js";
import { FOLLOW_PERSONAL_REASON } from "./profiles.js";
import { aiReply } from "./ai.js";

/**
 * СТОРОЖ «БЕЗ ОТВЕТА» (владелец 09.11.2026: «сделай так, чтобы никто не
 * оставался без ответа»). С 11.11.2026 — БЕЗ СООБЩЕНИЙ В TELEGRAM.
 *
 * Бот иногда молчит НАРОЧНО: Ширин только что ответила сама. Она ответила один
 * раз и ушла — клиент спросил ещё и ждал вечно. Раз в 5 минут сторож смотрит
 * переписки Instagram за последние сутки: последнее сообщение — от клиента,
 * старше `unansweredAfterMinutes` (15 мин), по делу (не «спасибо/ок/смайлик»), и
 * после него никто не ответил. Если бот молчал из-за паузы после ответа Ширин
 * (humanSilenceHours, 3 ч), а пауза уже кончилась — бот отвечает сам на всё, что
 * пришло за паузу.
 *
 * Раньше во всех остальных случаях сторож писал владельцу «⏳ Ждут ответа в
 * директе» (и про комментарии) — почти каждые полчаса. Владелец 11.11.2026:
 * «мне такой мусор вообще не нужен, кто ждёт ответа в Telegram — не надо».
 * Теперь молчим: кто ждёт, видно в панели, и бот сам ответит, когда пауза кончится.
 *
 * НЕ ТРОГАЕМ: отметку «личный», поставленную вручную, и «похоже на родню»,
 * заблокированных за спам, WhatsApp и Messenger, людей с отобранным доступом.
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
      channel: "INSTAGRAM",
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
    const waiting = waitingOf(raw, since, cutoff);
    if (!waiting) continue;
    const { contact, pending } = waiting;
    const lastIn = pending[0];
    // Отметку «личный» вручную и «похоже на родню» не трогаем вовсе — это не клиенты.
    if (contact.personal && contact.personalReason !== FOLLOW_PERSONAL_REASON) continue;

    // ПАУЗА КОНЧИЛАСЬ — ОТВЕЧАЕТ БОТ. Сообщение пришло, пока Ширин вела
    // разговор, она не ответила, а пауза уже прошла: дальше ждать некого.
    const takeoverEnds = humanTakeoverEndsAt(contact, silenceMs);
    const askedHuman = Boolean(contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > now.getTime());
    const pauseOver = takeoverEnds !== null && takeoverEnds !== Infinity && now.getTime() >= takeoverEnds;
    const arrivedDuringPause = takeoverEnds !== null && lastIn.createdAt.getTime() < takeoverEnds;
    const texts = pending.map((m) => m.text?.trim()).filter((t): t is string => Boolean(t)).reverse();
    if (
      !(pauseOver && arrivedDuringPause) || contact.personal || askedHuman || texts.length === 0 ||
      now.getTime() - lastIn.createdAt.getTime() >= REPLY_WINDOW_MS || replies >= MAX_REPLIES_PER_TICK
    ) continue;

    // Фильтр «не по делу» уже решил молчать (курьер, магазин, знакомая) — это решение, не забывчивость.
    const gateSilent = await prisma.replyGate.findFirst({
      where: { contactId: contact.id, action: "silent", createdAt: { gte: pending[pending.length - 1].createdAt } },
      select: { id: true },
    });
    if (gateSilent) continue;
    if (await offlineHandoffSilences(contact)) continue;

    if (!(await claim(contact.id, lastIn.createdAt, now))) continue;
    replies++;
    try {
      await aiReply(contact, texts.join("\n"));
    } catch (err) {
      logError("unansweredWatch:reply", err);
    }
  }
}
