import { prisma, getSetting, logError } from "./db.js";
import { sendMessageWithButtons } from "./telegram.js";
import { getQuickReplies } from "./quickReplies.js";
import { offsetMs, localDayStart, plural, truncate, STUCK_MESSAGE_THRESHOLD } from "./dailyReport.js";

/**
 * РЕАЛТАЙМ-ВЕРСИЯ секции «где бот застрял» из вечерней сводки (dailyReport.ts).
 *
 * Сводка находит застрявшие разговоры раз в сутки, в 23:00 — хозяйка узнаёт об
 * этом только на следующее утро. Эта функция дёргается из ai.ts СРАЗУ после
 * того, как бот отправил очередной ответ, и, если разговор уже выглядит
 * застрявшим, шлёт алерт в Telegram немедленно — тем же двум получателям, что и
 * сводка (владелец + сестра), с теми же кнопками быстрых ответов, что у
 * «просит человека» (см. ai.ts callOwnerToChat).
 *
 * НАМЕРЕННО не пытается подавить строку в завтрашней сводке, даже если алерт
 * уже ушёл сегодня: сводка — страховка на случай, если это уведомление по
 * какой-то причине не сработало (слишком длинный cooldown, пропустили пуш в
 * Telegram) — двойной сигнал по одному и тому же разговору это нормально и
 * ожидаемо, а не баг.
 *
 * Порог «застрял» (3+ входящих) и окно «сегодня» — ровно те же, что в
 * dailyReport.ts (общие STUCK_MESSAGE_THRESHOLD/offsetMs/localDayStart), чтобы
 * два места никогда не расходились в показаниях о том, что считать «застрял».
 */

const DEFAULT_COOLDOWN_HOURS = 2;

/** Число из настроек. `Number(null)` в JavaScript равен НУЛЮ, а не NaN — та же
 *  грабля, что и в learningCheckIn.ts/dailyReport.ts: без проверки пустая
 *  настройка cooldown'а тихо превращалась бы в ноль, и алерт слался бы на
 *  каждое сообщение подряд. */
async function cooldownHours(): Promise<number> {
  const raw = (await getSetting("stuckAlertCooldownHours"))?.trim();
  if (!raw) return DEFAULT_COOLDOWN_HOURS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COOLDOWN_HOURS;
}

/**
 * Вызывается из ai.ts (aiReply) СРАЗУ после того, как бот отправил ответ —
 * fire-and-forget, ошибка здесь не должна задевать сам ответ бота (тот же
 * приём, что у markStartedLearningIfReplied). Принимает id контакта, а не сам
 * объект — все нужные поля (paid, stuckAlertSentAt) читаются заново из базы,
 * чтобы не работать со значениями, которые могли устареть к моменту вызова.
 */
export async function notifyIfStuck(contactId: string): Promise<void> {
  // Выключатель в панели (Настройки) — владелец решил 25.08.2026 выключить эту
  // живую тревогу совсем: те же случаи и так видны в вечерней сводке (23:00).
  // По умолчанию включено — тот же приём, что styleLearningEnabled.
  if ((await getSetting("stuckAlertEnabled")) === "false") return;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;

  const offset = await offsetMs();
  const range = { gte: localDayStart(0, offset), lte: new Date() };

  const inCount = await prisma.message.count({
    where: { contactId, direction: "IN", createdAt: range },
  });
  if (inCount < STUCK_MESSAGE_THRESHOLD) return;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { paid: true, stuckAlertSentAt: true, username: true, igUserId: true },
  });
  if (!contact || contact.paid) return; // оплатил — не застрял, а купил

  const cooldownMs = (await cooldownHours()) * 3_600_000;
  if (contact.stuckAlertSentAt && Date.now() - contact.stuckAlertSentAt.getTime() < cooldownMs) return;

  // Сестра уже ответила сама (byHuman) в этом же окне — это обработанный
  // вручную случай, не провал бота (тот же критерий, что в dailyReport.ts, и
  // по той же причине читаем journal сообщений, а не humanSilencedUntil — это
  // поле-таймер могло уже протухнуть, даже если вмешательство было только что).
  const humanTouched = await prisma.message.count({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: range },
  });
  if (humanTouched > 0) return;

  // 24.08.2026: владелец попросил именно эту, живую тревогу слать только ему,
  // не сестре — застрявший разговор он хочет разбирать сам, без дублирования в
  // её чат. Остальные алерты (сомнительный чек и т.д.) по-прежнему уходят обоим.
  const recipients = [(await getSetting("telegramReportChatId"))?.trim()].filter(
    (id): id is string => Boolean(id)
  );
  if (recipients.length === 0) return;

  // Отметка ставится ДО отправки — тот же приём, что в dailyReport.ts/
  // learningCheckIn.ts: лучше пропустить повторный алерт при сбое Telegram, чем
  // на гонке двух почти одновременных входящих сообщений отправить его дважды.
  await prisma.contact.update({ where: { id: contactId }, data: { stuckAlertSentAt: new Date() } }).catch((err) => {
    logError("stuckAlert:markSent", err);
  });

  const lastIn = await prisma.message.findFirst({
    where: { contactId, direction: "IN", createdAt: range },
    orderBy: { createdAt: "desc" },
    select: { text: true },
  });
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const hint = lastIn?.text ? truncate(lastIn.text, 200) : "(без текста)";
  // 24.08.2026: раньше здесь было "ответа нет" — неправда, эта функция вызывается
  // СРАЗУ ПОСЛЕ того, как бот уже ответил (см. вызовы в ai.ts). Порог "3+ сообщения
  // за день" — сигнал "человек активно спрашивает, но ещё не купил и не с
  // сестрой", а не "бот молчит". Владелец 24.08.2026 запутался, увидев "ответа
  // нет" в переписке, где бот отвечал вовремя — текст поправлен, чтобы не врать.
  const text =
    `🧩 Активный интерес без покупки — ${inCount} ${plural(inCount, "сообщение", "сообщения", "сообщений")} ` +
    `сегодня, бот отвечает, но до оплаты не дошло.\n` +
    `Человек: ${who}\n` +
    `Последнее: «${hint}»`;

  // Те же кнопки быстрых ответов, что под уведомлением «просит человека» (см.
  // ai.ts callOwnerToChat) — можно закрыть застрявший разговор одним нажатием,
  // не открывая Instagram.
  const quickReplies = await getQuickReplies();
  const buttons = quickReplies.map((qr, i) => [{ text: qr.label, callback_data: `qr:${contactId}:${i}` }]);

  for (const chatId of recipients) {
    await sendMessageWithButtons(botToken, chatId, text, buttons);
  }
}
