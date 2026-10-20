import { prisma, getSetting, setSetting, logError } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";
import { unansweredCount } from "./course/chat.js";
import { globalAiUsageToday } from "./ai/dailyBudget.js";
import { completedCoursesSince, purchaseChannel, CHANNEL_TITLE, type PurchaseChannel } from "./metrics.js";

/**
 * Вечерняя сводка — в 23:00 по Душанбе, за ТЕКУЩИЙ день. Уходит двоим сразу:
 * владельцу и сестре (она ведёт офлайн-курс и обзванивает записавшихся).
 *
 * Часовой пояс Душанбе — UTC+5, контейнер живёт в UTC (та же грабля, что в
 * основной CRM). И «когда слать», и границы суток считаются со сдвигом, а не
 * через локальное время сервера.
 */
const DEFAULT_OFFSET_HOURS = 5; // Душанбе, UTC+5
const DEFAULT_REPORT_HOUR = 23;
/** Ключ отметки «за этот день уже отправлено». Живёт В БАЗЕ, а не в памяти:
 *  переменная процесса обнуляется при каждом перезапуске контейнера, и после
 *  трёх выкатов подряд сводка ушла три раза — ровно это и случилось 21.08. */
const SENT_KEY = "dailyReportSentDay";

/**
 * Число из настроек. Отдельная функция потому, что `Number(null)` в JavaScript
 * равен НУЛЮ, а не NaN: пустая настройка «часа отчёта» тихо превращалась в 0:00,
 * и сводка уходила сразу после полуночи вместо 23:00. Часовой пояс ломался так же
 * — сдвиг 0 вместо +5.
 */
async function numberSetting(key: string, fallback: number): Promise<number> {
  const raw = (await getSetting(key))?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Экспортировано: тот же сдвиг часового пояса нужен вживую в stuckAlert.ts
 *  (реалтайм-версия «где бот застрял»), чтобы окно «сегодня» считалось ровно
 *  так же, как в этой сводке, и обе фичи не расходились в показаниях. */
export async function offsetMs(): Promise<number> {
  return (await numberSetting("timezoneOffsetHours", DEFAULT_OFFSET_HOURS)) * 3_600_000;
}

async function reportHour(): Promise<number> {
  const raw = await numberSetting("reportHour", DEFAULT_REPORT_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_REPORT_HOUR;
}

/** Начало местных суток, выраженное в UTC. Экспортировано — см. offsetMs выше. */
export function localDayStart(daysAgo: number, offset: number): Date {
  const local = new Date(Date.now() + offset);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - daysAgo);
  return new Date(local.getTime() - offset);
}

/** Экспортировано для stuckAlert.ts — тот же текст числительного и там, и тут. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Экспортировано для stuckAlert.ts — тот же обрез длинного текста цитаты. */
export function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Чек висит без решения владельца дольше этого — отдельная, более тревожная
 *  строка сводки (см. LONG_PENDING ниже): «ждут решения» само по себе не пугает,
 *  а вот «висит третий час» — уже повод открыть Telegram прямо сейчас. */
const LONG_PENDING_HOURS = 2;

/** 3+ входящих от одного человека за окно — порог «бот застрял» и здесь (сводка
 *  раз в сутки), и в реалтайм-версии (stuckAlert.ts, алерт в момент, когда порог
 *  впервые достигнут). Общая константа — чтобы обе фичи не разошлись в цифре. */
export const STUCK_MESSAGE_THRESHOLD = 3;

/**
 * УЧЁБА И СИСТЕМА — вторая половина сводки (v2, «Утро Ширин» §11): начали
 * учиться, дошли до конца, сертификаты, вопросы без ответа, расход Gemini,
 * выручка по каналам. Отдельной функцией — чтобы buildReport не разросся, и
 * чтобы каждую цифру можно было проверить в тесте по одному моку.
 */
export async function learningSummary(range: { gte: Date; lte: Date }): Promise<{
  started: number;
  finished: number;
  certificates: number;
  unanswered: number;
  gemini: { calls: number; limit: number };
  byChannel: { channel: PurchaseChannel; count: number; sum: number }[];
}> {
  const [started, finishedAll, certificates, unanswered, gemini, purchases] = await Promise.all([
    // «Начала учиться» = открыла первый урок на платформе ИЛИ вошла в Telegram-группу:
    // раньше считалось только первое, а выдача идёт в Telegram — стояло 0 всегда.
    prisma.purchase.count({ where: { revokedAt: null, OR: [{ firstOpenedAt: range }, { joinedAt: range }] } }),
    completedCoursesSince(range.gte),
    prisma.certificate.count({ where: { issuedAt: range } }),
    unansweredCount(),
    globalAiUsageToday(),
    prisma.purchase.findMany({
      where: { createdAt: range, revokedAt: null },
      select: { amount: true, source: true, contact: { select: { channel: true } } },
    }),
  ]);
  const channels = new Map<PurchaseChannel, { channel: PurchaseChannel; count: number; sum: number }>();
  for (const p of purchases) {
    const ch = purchaseChannel(p);
    const b = channels.get(ch) ?? { channel: ch, count: 0, sum: 0 };
    b.count += 1;
    b.sum += p.amount;
    channels.set(ch, b);
  }
  return {
    started,
    // completedCoursesSince отдаёт покупки с завершением в окне; «дошла до
    // конца сегодня» — та, у которой ПОСЛЕДНИЙ урок закрыт сегодня.
    finished: finishedAll.filter((f) => f.finishedAt >= range.gte && f.finishedAt <= range.lte).length,
    certificates,
    unanswered,
    gemini,
    byChannel: [...channels.values()].sort((a, b) => b.sum - a.sum),
  };
}

function handleOfContact(c: { username: string | null; igUserId: string }): string {
  return c.username ? `@${c.username}` : `ID ···${c.igUserId.slice(-6)}`;
}

/** Экспортировано для тестов: текст сводки собирается из моков базы. */
export async function buildReport(offset: number): Promise<string> {
  // Сегодняшний день: от полуночи до «сейчас».
  const from = localDayStart(0, offset);
  const range = { gte: from, lte: new Date() };
  const longPendingSince = new Date(Date.now() - LONG_PENDING_HOURS * 3_600_000);

  const [inMessages, funnelStarts, paidToday, offlineSignups, pendingAll, unchecked, longPending, learning, spamBlocked] = await Promise.all([
    // Не distinct: полный список нужен и для «написали», и для поиска застрявших
    // разговоров ниже (3+ сообщений от одного человека за окно).
    prisma.message.findMany({
      where: { direction: "IN", createdAt: range },
      select: { contactId: true, text: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.delivery.count({ where: { createdAt: range } }),
    // Продажи считаем по ФАКТУ оплаты у человека (paidAt), а не по записям о
    // чеках: доступ мог открыть и бот, и владелец кнопкой в Telegram, и живая
    // хозяйка руками — во всех трёх случаях это одна и та же продажа.
    prisma.contact.findMany({
      where: { paid: true, paidAt: range },
      select: { id: true, receiptChecks: { where: { linkSent: true }, select: { amount: true }, take: 1 } },
    }),
    prisma.offlineSignup.findMany({ where: { createdAt: range }, select: { name: true, phone: true } }),
    prisma.receiptCheck.count({ where: { ownerDecision: "PENDING" } }),
    prisma.receiptCheck.count({ where: { kind: "unchecked" } }),
    // Не «сегодня» — чек, пришедший вчера вечером и всё ещё не решённый, тревожнее
    // любого сегодняшнего, поэтому без границы суток, просто дольше двух часов.
    prisma.receiptCheck.count({ where: { ownerDecision: "PENDING", createdAt: { lte: longPendingSince } } }),
    learningSummary(range),
    prisma.contact.findMany({ where: { spamBlockedAt: range }, select: { username: true, igUserId: true } }).then(
      // В тестах один мок contact.findMany обслуживает и оплаты — берём только строки с igUserId.
      (rows) => rows.filter((c) => typeof c.igUserId === "string")
    ),
  ]);

  // Группируем входящие по контакту один раз: отсюда и число написавших, и
  // список застрявших разговоров ниже — вместо двух отдельных запросов/проходов.
  const byContact = new Map<string, { count: number; lastText: string | null }>();
  for (const m of inMessages) {
    const entry = byContact.get(m.contactId) ?? { count: 0, lastText: null };
    entry.count += 1;
    entry.lastText = m.text ?? entry.lastText; // сообщения идут по возрастанию времени — переживает последнее
    byContact.set(m.contactId, entry);
  }
  const wroteIds = [...byContact.keys()];
  const wroteCount = wroteIds.length;

  // «Новых» считаем СРЕДИ НАПИСАВШИХ, а не все заведённые за день карточки:
  // карточка создаётся и на комментарий, и на эхо, поэтому новых выходило
  // больше, чем написавших («15 чел., новых 19»), и сводка выглядела враньём.
  const newAmongThem = wroteIds.length
    ? await prisma.contact.count({ where: { id: { in: wroteIds }, createdAt: range } })
    : 0;

  // «Где бот застрял» — 3+ входящих от одного человека за окно, и разговор
  // ничем не кончился: ни оплатой, ни личным вмешательством сестры (если она
  // ответила сама, это уже не провал бота, а обработанный вручную случай —
  // см. handleReaction/handleMessage в webhook.ts).
  const stuckCandidateIds = [...byContact.entries()]
    .filter(([, v]) => v.count >= STUCK_MESSAGE_THRESHOLD)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([id]) => id);

  let stuck: { handle: string; count: number; lastText: string | null }[] = [];
  if (stuckCandidateIds.length > 0) {
    const [candidates, humanTouched] = await Promise.all([
      prisma.contact.findMany({
        where: { id: { in: stuckCandidateIds } },
        select: { id: true, username: true, igUserId: true, paid: true, paidAt: true },
      }),
      // Смотрим по сообщениям (byHuman=true), а не по humanSilencedUntil: это
      // поле — таймер, который перезаписывается и к вечеру мог уже протухнуть,
      // даже если вмешательство было прямо в это окно. Журнал сообщений — нет.
      prisma.message.findMany({
        where: { contactId: { in: stuckCandidateIds }, direction: "OUT", byHuman: true, createdAt: range },
        select: { contactId: true },
        distinct: ["contactId"],
      }),
    ]);
    const humanTouchedIds = new Set(humanTouched.map((m) => m.contactId));
    const candidateById = new Map(candidates.map((c) => [c.id, c]));

    stuck = stuckCandidateIds
      .filter((id) => {
        const c = candidateById.get(id);
        if (!c || humanTouchedIds.has(id)) return false;
        if (c.paid && c.paidAt && c.paidAt >= from) return false; // оплатил в этом же окне — не застрял, а купил
        return true;
      })
      .slice(0, 5)
      .map((id) => {
        const c = candidateById.get(id)!;
        const s = byContact.get(id)!;
        return { handle: c.username ? `@${c.username}` : c.igUserId, count: s.count, lastText: s.lastText };
      });
  }

  // Ники для «Долго висят без решения» — отдельным запросом и только когда
  // счётчик выше нуля, тем же принципом, что и у «застрял» чуть выше: не тянуть
  // лишнее, когда сводке нечего показывать.
  let longPendingHandles: string[] = [];
  if (longPending > 0) {
    const rows = await prisma.receiptCheck.findMany({
      where: { ownerDecision: "PENDING", createdAt: { lte: longPendingSince } },
      include: { contact: { select: { username: true, igUserId: true } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    longPendingHandles = rows.map((r) => (r.contact.username ? `@${r.contact.username}` : r.contact.igUserId));
  }

  const amounts = paidToday.map((c) => c.receiptChecks[0]?.amount ?? null);
  const known = amounts.filter((a): a is number => a != null);
  const revenue = known.reduce((sum, a) => sum + a, 0);
  const unknownAmount = amounts.length - known.length;

  // toLocaleDateString(from) без timeZone брал бы часовой пояс КОНТЕЙНЕРА (UTC) —
  // полночь Душанбе (UTC+5) это 19:00 предыдущих суток по UTC, заголовок сводки
  // показывал бы вчерашнее число каждый вечер. Сдвигаем инстант на offset и читаем
  // календарную дату через UTC-геттеры — тот же приём, что у localDayStart выше.
  const day = new Date(from.getTime() + offset).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const lines = [`🌙 Итог за ${day}`, ``];

  lines.push(`💬 Написали — ${wroteCount} ${plural(wroteCount, "человек", "человека", "человек")}`);
  if (newAmongThem > 0) lines.push(`🆕 Новых — ${newAmongThem}`);
  if (funnelStarts > 0) lines.push(`🎯 Пришли с комментария под роликом — ${funnelStarts}`);
  if (spamBlocked.length > 0) {
    lines.push(`🚫 Заблокированы за спам/флирт — ${spamBlocked.length}: ${spamBlocked.map((c) => handleOfContact(c)).join(", ")}`);
  }
  lines.push(``);

  if (paidToday.length === 0) {
    lines.push(`💰 Оплат сегодня нет`);
  } else {
    lines.push(`💰 Оплатили онлайн-курс — ${paidToday.length}`);
    if (revenue > 0) lines.push(`     на ${revenue} сомони`);
    if (unknownAmount > 0) {
      lines.push(`     ещё ${unknownAmount} без суммы (доступ выдан вручную)`);
    }
  }
  // Откуда пришли деньги — по покупкам (Purchase), канал выводится из контакта
  // (metrics.ts). Одна строка, только когда есть что делить.
  if (learning.byChannel.length > 0) {
    lines.push(`     ${learning.byChannel.map((b) => `${CHANNEL_TITLE[b.channel]} ${b.sum} с. (${b.count})`).join(" · ")}`);
  }

  // УЧЁБА — то, чего в сводке не было вовсе: платформа живёт, а хозяйка
  // видела только деньги и чеки.
  lines.push(``);
  lines.push(`📚 Начали учиться — ${learning.started}`);
  if (learning.finished > 0) lines.push(`🏁 Дошли до конца — ${learning.finished}`);
  if (learning.certificates > 0) {
    lines.push(`🎓 Сертификатов — ${learning.certificates}`);
  }
  if (learning.unanswered > 0) {
    lines.push(`❓ Вопросов учениц без ответа сейчас — ${learning.unanswered}`);
  }
  // Расход Gemini в сводке владельцу непонятен («что это решает?») — остаётся
  // в панели и в тревоге на 80/100 % (ai/dailyBudget.ts).
  if (learning.gemini.limit > 0 && learning.gemini.calls >= learning.gemini.limit * 0.8) {
    lines.push(`⚠️ ИИ почти исчерпал дневной лимит (${learning.gemini.calls} из ${learning.gemini.limit}) — ночью бот может замолчать`);
  }

  lines.push(``);
  if (offlineSignups.length === 0) {
    lines.push(`📝 На офлайн-курс сегодня не записывались`);
  } else {
    lines.push(`📝 Записались на офлайн-курс — ${offlineSignups.length}:`);
    for (const s of offlineSignups) lines.push(`     ${s.name} — ${s.phone}`);
  }

  if (pendingAll > 0 || unchecked > 0) {
    lines.push(``);
    if (pendingAll > 0) lines.push(`⏳ Ждут вашего решения — ${pendingAll} ${plural(pendingAll, "чек", "чека", "чеков")}`);
    if (unchecked > 0) lines.push(`🔄 Перепроверяются — ${unchecked}`);
  }

  if (longPending > 0) {
    lines.push(``);
    lines.push(`⏰ Долго висят без решения — ${longPending} ${plural(longPending, "чек", "чека", "чеков")}`);
    for (const h of longPendingHandles) lines.push(`     ${h}`);
    if (longPending > longPendingHandles.length) lines.push(`     …и ещё ${longPending - longPendingHandles.length}`);
  }

  // «Где бот застрял» владелец из сводки убрал (05.09.2026): те же разговоры
  // видны в панели («Сегодня» → вопросы, «Ученицы»), в вечернем письме это шум.
  void stuck;

  if (wroteCount === 0) lines.push(``, `Сегодня никто не писал.`);
  return lines.join("\n");
}

/** Дёргается тем же тиком, что и разносчик воронок (раз в 10 секунд), но реально
 *  шлёт раз в сутки: отметка отправленного дня лежит в базе и переживает
 *  перезапуск контейнера. */
export async function maybeSendDailyReport(): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;

  const offset = await offsetMs();
  const local = new Date(Date.now() + offset);
  const today = local.toISOString().slice(0, 10);
  if (local.getUTCHours() < (await reportHour())) return;
  if ((await getSetting(SENT_KEY))?.trim() === today) return;

  // Двое получателей: сестра и владелец. Дубли (если указан один и тот же
  // chat_id) отсекаем — иначе одному человеку придут два одинаковых письма.
  const recipients = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter((id): id is string => Boolean(id));
  const unique = [...new Set(recipients)];
  if (unique.length === 0) return;

  // Отметка ставится ДО отправки: если Telegram не ответит, лучше пропустить
  // сводку за день, чем зациклить попытки каждые 10 секунд до конца суток.
  await setSetting(SENT_KEY, today);
  try {
    const text = await buildReport(offset);
    for (const chatId of unique) {
      await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("dailyReport:send", err));
    }
  } catch (err) {
    logError("dailyReport", err);
  }
}
