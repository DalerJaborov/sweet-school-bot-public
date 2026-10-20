import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { sendToContact } from "./messaging/send.js";

/**
 * «Зашла в группу» ещё не значит «начала учиться». Telegram не даёт «прочитано»
 * на посты в закрытом канале — узнать, посмотрела ли она первый урок, нельзя.
 * Вместо этого — практический прокси-сигнал: через несколько дней после входа
 * бот сам спрашивает, как дела с первым уроком, а `startedLearning` в ai.ts
 * ставится, когда человек хоть что-нибудь отвечает (см. markStartedLearningIfReplied).
 *
 * Структура — прямая копия joinReminder.ts: тот же флаг занятости, то же окно
 * Meta 24 часа, тот же двуязычный текст «апачон».
 */

const DEFAULT_CHECK_IN_DAYS = 3;
/** Meta пускает нас писать первым только 24 часа после сообщения человека. */
const META_WINDOW_HOURS = 24;

const TEXT_TG = "Дарси якум чи хел гузашт? Мушкиле надоред? 🌸";
const TEXT_RU = "Как первый урок? Всё получилось? 🌸";


export async function runLearningCheckIns(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("learningCheckIn", sweep);
}

/** Число дней из настроек. `Number(null)` в JavaScript равен НУЛЮ, а не NaN —
 *  без проверки пустая настройка слала бы проверочное сообщение сразу же. */
async function checkInDays(): Promise<number> {
  const raw = (await getSetting("learningCheckInDays"))?.trim();
  if (!raw) return DEFAULT_CHECK_IN_DAYS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHECK_IN_DAYS;
}

async function sweep(): Promise<void> {
  const days = await checkInDays();
  const since = new Date(Date.now() - days * 86_400_000);
  const waiting = await prisma.purchase.findMany({
    where: {
      joinedAt: { not: null, lte: since },
      learningCheckInSentAt: null,
      revokedAt: null,
      contact: { personal: false },
    },
    include: { contact: true },
    take: 20,
  });
  if (waiting.length === 0) return;

  for (const purchase of waiting) {
    const contact = purchase.contact;

    // Отметку ставим ПЕРВОЙ: проверочное сообщение обещано одно, и лучше
    // пропустить его при сбое, чем послать дважды (тот же приём, что в
    // joinReminder.ts).
    await prisma.purchase.update({ where: { id: purchase.id }, data: { learningCheckInSentAt: new Date() } });

    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, text: true },
    });
    const windowOpen =
      lastIn != null && (Date.now() - lastIn.createdAt.getTime()) / 3_600_000 < META_WINDOW_HOURS;
    if (!windowOpen) continue; // окно Meta закрыто — писать первым нельзя

    // Язык берём по последнему сообщению человека, как и в joinReminder.ts.
    const tajik = /[ҳҷқғӯӣ]|шумо|апа|курс(и|ро)/i.test(lastIn?.text ?? "");
    const text = tajik ? TEXT_TG : TEXT_RU;
    try {
      const mid = await sendToContact(contact, text);
      await recordOutgoingMessage(contact.id, text, mid);
    } catch (err) {
      logError("learningCheckIn:send", err);
    }
  }
}

/**
 * Любой ответ клиента ПОСЛЕ отправленного проверочного сообщения — сигнал, что
 * она жива и вовлечена (что именно она написала, не важно). Дергается из ai.ts
 * на КАЖДОЕ входящее сообщение — fire-and-forget, ошибка здесь не должна
 * задевать сам ответ бота.
 *
 * Найти нужно САМУЮ СВЕЖУЮ покупку, где сообщение уже отправлено, а флаг ещё не
 * стоит — если куплено два курса и на оба ушла проверка, ответ засчитываем той,
 * что спросили последней. Назад флаг никогда не откатывается.
 */
export async function markStartedLearningIfReplied(contactId: string): Promise<void> {
  const purchase = await prisma.purchase.findFirst({
    where: { contactId, learningCheckInSentAt: { not: null }, startedLearning: false },
    orderBy: { learningCheckInSentAt: "desc" },
  });
  if (!purchase) return;
  await prisma.purchase.update({ where: { id: purchase.id }, data: { startedLearning: true } });
}
