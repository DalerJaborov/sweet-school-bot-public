import { prisma, getSetting, logError } from "./db.js";
import { offsetMs } from "./dailyReport.js";
import { notifyOwnerDirect } from "./systemAlerts.js";
import { shouldSendAlert } from "./alertGate.js";
import { deliberateSilenceSince } from "./ai/deliberateSilence.js";
import { isPureThanks } from "./ai/reactions.js";
import { resolveGeminiKeys } from "./ai/geminiKeys.js";
import { releaseExpiredTakeovers, loadTakeoverConfig, ownerAnchor, decideTakeover } from "./ai/ownerTakeover.js";
import { healFalseTakeovers } from "./ai/takeoverHeal.js";

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
 * дольше `inboundSilenceHours` (по умолчанию 4) — состояние «тишина» в панели
 * и /health. Сообщение в Telegram НЕ отправляется никому (решение владельца
 * 08.11.2026: шум). Ночью не считаем: тишина в три часа ночи это норма, а не поломка.
 */

const DEFAULT_SILENCE_HOURS = 4;
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;

type State = { silentHours: number; alerting: boolean };

let state: State = { silentHours: 0, alerting: false };

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
  const dayStartUtc =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), WORK_START_HOUR) - offset;
  const from = Math.max(last.createdAt.getTime(), dayStartUtc);
  const silentHours = Math.max(0, now.getTime() - from) / 3_600_000;
  const threshold = await thresholdHours();
  const alerting = workingHours && silentHours >= threshold;
  state = { silentHours: Math.round(silentHours * 10) / 10, alerting };
}

/** Только для тестов. */
export function resetInboundWatch(): void {
  state = { silentHours: 0, alerting: false };
}

/**
 * СТОРОЖ НЕОТВЕЧЕННЫХ (08.11.2026, владелец: «бот никогда не должен замолкать без причины»).
 *
 * Глобальный сторож выше ловит «входящих нет совсем». Этот — обратное: сообщение
 * клиента пришло, а ответа нет дольше двух минут, хотя бот включён. Не важно, КАКОЙ
 * из десятка путей молчания сработал (ложная пауза от эха, пустой ключ ИИ, упавшая
 * очередь) — если никто не ответил и причина не записана как намеренная, владельцу
 * уходит тревога с именем клиента и вероятной причиной. Одна тревога на одно
 * сообщение (alertGate, состояние в базе).
 *
 * Намеренное молчание, которое НЕ тревожит: личный контакт и спам-блок, просьба
 * позвать человека (владельцу уже ушло уведомление), живой ответ Ширин, «спасибо»
 * без вопроса (реакция), чек у владельца на проверке, отказы с записанной причиной
 * (ai/deliberateSilence.ts, журнал шлюза «не по делу»). Бот выключен или заморожен —
 * тоже не тревога: так решил владелец.
 */
export const UNANSWERED_AFTER_MS = 2 * 60_000;
const LOOKBACK_MS = 24 * 3_600_000;
/** Запас после конца паузы хозяйки, прежде чем молчание считается сбоем. */
const TAKEOVER_GRACE_MS = 4 * 60_000;
const PROCESS_STARTED_AT = Date.now();
const MAX_ALERTS_PER_TICK = 5;

const fmt = (d: Date, offset: number): string => {
  const l = new Date(d.getTime() + offset);
  return `${String(l.getUTCDate()).padStart(2, "0")}.${String(l.getUTCMonth() + 1).padStart(2, "0")} ${String(l.getUTCHours()).padStart(2, "0")}:${String(l.getUTCMinutes()).padStart(2, "0")}`;
};

export type UnansweredReason = { skip: true; why: string } | { skip: false; reason: string; dedupeKey?: string };

/** Почему на последнее входящее нет ответа: намеренно (skip) или нет (reason). */
export async function explainUnanswered(
  contactId: string,
  lastIn: { createdAt: Date; text: string | null },
  now: Date,
): Promise<UnansweredReason> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { skip: true, why: "контакта нет" };
  if (contact.personal) return { skip: true, why: "личный контакт" };
  if (contact.spamBlockedAt) return { skip: true, why: "спам-блок" };
  if (contact.whatsappSavedContact) return { skip: true, why: "контакт в телефоне хозяйки" };
  if (contact.humanRequestedAt && contact.humanRequestedAt.getTime() >= lastIn.createdAt.getTime() - 5 * 60_000) {
    return { skip: true, why: "просили позвать человека" };
  }
  if (lastIn.text && isPureThanks(lastIn.text)) return { skip: true, why: "спасибо без вопроса" };
  const note = deliberateSilenceSince(contactId, lastIn.createdAt);
  if (note) return { skip: true, why: note };
  const gate = await prisma.replyGate.findFirst({ where: { contactId, createdAt: { gte: lastIn.createdAt } } });
  if (gate) return { skip: true, why: `шлюз «не по делу»: ${gate.reason}` };
  const receipt = await prisma.receiptCheck.findFirst({
    where: { contactId, createdAt: { gte: new Date(lastIn.createdAt.getTime() - 60_000) }, ownerDecision: "PENDING" },
  });
  if (receipt) return { skip: true, why: "чек ждёт решения владельца" };

  // Дальше — молчание без записанной причины. Подбираем самое вероятное объяснение.
  // Живая хозяйка ведёт разговор — это намеренная пауза, шуметь про неё нельзя (разбор
  // «умного перехвата» — отдельная задача). Подозрительной считаем только паузу, причину
  // которой не видно: нет сообщения-причины или у него нет текста (вложение) — так выглядит
  // и ложное эхо нашей картинки. Одна тревога на паузу (ключ — mid причины).
  if (contact.humanTakenOverAt) {
    const cause = contact.humanTakeoverMid
      ? await prisma.message.findUnique({ where: { mid: contact.humanTakeoverMid } })
      : null;
    if (cause?.text) {
      // Согласовано с умным перехватом (ai/ownerTakeover.ts): пауза должна была закончиться — бот обязан был ответить.
      const config = await loadTakeoverConfig();
      const anchor = await ownerAnchor(contact);
      if (!config.enabled || !anchor) return { skip: true, why: "живая пауза хозяйки" };
      const d = decideTakeover({ config, anchor, incomingAt: lastIn.createdAt, safeIntent: false, now });
      if (d.action === "hold") return { skip: true, why: "живая пауза хозяйки" };
      // Запас к концу паузы: очередь ответов отвечает по тику, сторож не должен гоняться с ней.
      if (d.why === "idle" || d.why === "cold") {
        const dueAt = Math.min(
          anchor.getTime() + config.liveWindowMin * 60_000,
          lastIn.createdAt.getTime() + config.idleReplyMin * 60_000,
        );
        if (now.getTime() - dueAt < TAKEOVER_GRACE_MS)
          return { skip: true, why: "пауза хозяйки только что закончилась, ответ в очереди" };
      }
      return {
        skip: false,
        reason: "перехват хозяйки уже должен был закончиться (" + d.why + "), но бот не ответил",
        dedupeKey: "takeover-due:" + contactId + ":" + lastIn.createdAt.getTime(),
      };
    }
    return {
      skip: false,
      reason: `бот на паузе с ${fmt(contact.humanTakenOverAt, await offsetMs())}, а причина паузы — сообщение без текста (вложение): возможно, это было наше же эхо`,
      dedupeKey: `takeover:${contact.humanTakeoverMid ?? contactId}`,
    };
  }
  if (contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > now.getTime()) {
    return { skip: true, why: "пауза после действия хозяйки или просьбы позвать человека" };
  }
  // WhatsApp: очередь «нужен человек», обработка и просроченные события ведёт сам мост;
  // эти строки уже видны владельцу в панели, повторная тревога была бы шумом.
  if (contact.channel === "WHATSAPP") {
    const inbox = await prisma.whatsAppInbox.findFirst({
      where: { contactId, createdAt: { gte: new Date(lastIn.createdAt.getTime() - 60_000) } },
    });
    if (inbox) return { skip: true, why: `WhatsApp: событие в очереди моста (${inbox.status})` };
  }
  const retry = await prisma.pendingAiReply.findFirst({ where: { contactId } });
  if (retry) return { skip: false, reason: `ИИ не ответил, ход ждёт повтора (попыток: ${retry.attempts})` };
  if ((await resolveGeminiKeys()).length === 0) return { skip: false, reason: "не заданы ключи ИИ" };
  return { skip: false, reason: "причина не найдена, смотрите журнал ошибок и переписку" };
}

export async function checkUnansweredInbound(now = new Date()): Promise<number> {
  if ((await getSetting("unansweredAlertEnabled")) === "false") return 0;
  // Бот выключен владельцем (пауза, заморозка) — молчание осознанное, тревожить нечем.
  if ((await getSetting("aiEnabled")) !== "true" || (await getSetting("botFrozen")) === "true") return 0;

  // Самолечение раньше сторожа: ложная пауза от нашего же эха снимается сама.
  await healFalseTakeovers().catch((err) => logError("takeoverHeal", err));
  await releaseExpiredTakeovers(now).catch((err) => logError("ownerTakeover:expire", err));

  // Окно начинается за 15 минут до старта: сообщение, потерянное при выкатке, тоже ловим.
  const since = new Date(Math.max(now.getTime() - LOOKBACK_MS, PROCESS_STARTED_AT - 15 * 60_000));
  const cutoff = new Date(now.getTime() - UNANSWERED_AFTER_MS);
  const recent = await prisma.message.findMany({
    where: { direction: "IN", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { contactId: true, createdAt: true, text: true },
    take: 500,
  });
  const latest = new Map<string, { createdAt: Date; text: string | null }>();
  for (const m of recent)
    if (!latest.has(m.contactId)) latest.set(m.contactId, { createdAt: m.createdAt, text: m.text });

  const offset = await offsetMs();
  const items: { who: string; when: string; preview: string; reason: string; channel: string }[] = [];
  for (const [contactId, lastIn] of latest) {
    if (items.length >= MAX_ALERTS_PER_TICK * 4) break;
    if (lastIn.createdAt.getTime() > cutoff.getTime()) continue; // ещё в пределах двух минут
    const answered = await prisma.message.count({
      where: { contactId, direction: "OUT", createdAt: { gt: lastIn.createdAt } },
    });
    if (answered > 0) continue;
    const verdict = await explainUnanswered(contactId, lastIn, now);
    if (verdict.skip) continue;
    // Одна тревога на одно сообщение (или на одну паузу); уже отправленные не тратят лимит тика.
    const key = verdict.dedupeKey ?? `unanswered:${contactId}:${lastIn.createdAt.getTime()}`;
    if (!(await shouldSendAlert(key, { cooldownMs: 24 * 3_600_000 }))) continue;
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { name: true, username: true, igUserId: true, channel: true },
    });
    items.push({
      who: contact?.name || (contact?.username ? "@" + contact.username : contact?.igUserId) || contactId,
      channel: contact?.channel ?? "?",
      when: fmt(lastIn.createdAt, offset),
      preview: lastIn.text ? "«" + lastIn.text.slice(0, 120) + "»" : "(вложение без текста)",
      reason: verdict.reason,
    });
  }
  if (items.length === 0) return 0;

  // Общая поломка (упал ИИ, пропал ключ) бьёт по многим клиентам сразу: вместо потока
  // сообщений в Telegram — одна сводка. Одна-две тревоги идут отдельно, с деталями.
  if (items.length <= 2) {
    for (const it of items) {
      await notifyOwnerDirect(
        "Бот не ответил клиенту: " +
          it.who +
          " (" +
          it.channel +
          ")\n" +
          "Написал(а) в " +
          it.when +
          ": " +
          it.preview +
          "\n" +
          "Причина: " +
          it.reason,
      ).catch((err) => logError("inboundWatch:unanswered", err));
    }
  } else {
    const lines = items.slice(0, 10).map((it) => "- " + it.who + " (" + it.when + "): " + it.reason);
    await notifyOwnerDirect(
      "Бот не ответил " +
        items.length +
        " клиентам дольше двух минут:\n" +
        lines.join("\n") +
        (items.length > 10 ? "\n...и ещё " + (items.length - 10) : ""),
    ).catch((err) => logError("inboundWatch:unanswered", err));
  }
  return items.length;
}
