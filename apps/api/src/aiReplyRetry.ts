import { canRetryMetaFailure } from "./messaging/metaErrors.js";
import { notifyOwnerDirect } from "./systemAlerts.js";
import { sendToContact } from "./messaging/send.js";
import { detectClientLanguage } from "./ai/clientLanguage.js";
import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { aiReply } from "./ai.js";
import { isBotFrozen } from "./messaging/automation.js";

/**
 * Очередь ответов, которые ИИ НИ РАЗУ не дал — все ключи/модели Gemini отказали.
 *
 * ЗАЧЕМ. У aiReply не было НИКАКОЙ подстраховки: провал — logError и тишина
 * навсегда, клиент терялся молча. Живой случай 29-30.08.2026: у Google
 * кончились предоплаченные кредиты на ~17 часов, и 4 реальных обращения
 * «хочу курс» не получили ни одного ответа — разбирать пришлось руками через
 * SSH. У приёма чеков (receiptRetry.ts) такая защита уже была — единственное
 * место, где отказ ИИ стоит денег, — у обычного ответа клиенту не было вовсе,
 * хотя цена того же отказа выше: не разобранный чек видно во вкладке «Чеки»,
 * а непроцаженный вопрос клиента не виден нигде, кроме журнала докер-логов.
 *
 * ПОЧЕМУ РАСПИСАНИЕ ДЛИННЕЕ, ЧЕМ У ЧЕКОВ. У receiptRetry шаг 3 минуты — там
 * сбой обычно короткий и разовый. Здесь причина может держаться часами
 * (кончились деньги на счету Google) — долбиться каждые 10 секунд значит жечь
 * суточный бюджет впустую на одном и том же диалоге. Расписание растущее:
 * быстро вначале (вдруг это секундный сбой сети — ровно то, что чаще всего и
 * происходит, см. RETRY_DELAYS_MS в gemini.ts), затем реже (вдруг это надолго).
 * Числа и общая идея — те же, что были в CRM (ai/aiRetryQueue.ts, ~13 часов):
 * ночной сбой поставщика переживается целиком, клиент из полуночи получает
 * ответ к утру, а не тишину.
 */

const DELAY_NOTICES = {
  ru: "Сейчас не получается подготовить ответ. Ваш вопрос сохранён, вернёмся к нему немного позже.",
  tg: "Ҳоло ҷавоб омода нашуд. Саволи шумо нигоҳ дошта шуд, каме дертар ба он бармегардем.",
  en: "Your question is saved. We cannot prepare an answer right now and will return to it later.",
};

const DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000]; // 1, 2, 5, 10, 15 минут
const TRAILING_DELAY_MS = 20 * 60_000;
const TRAILING_ATTEMPTS = 40; // ещё ~13 часов
const MAX_ATTEMPTS = DELAYS_MS.length + TRAILING_ATTEMPTS;

function delayFor(attempt: number): number {
  return DELAYS_MS[attempt] ?? TRAILING_DELAY_MS;
}

/** Кладёт ход в очередь — вызывать сразу после провала aiReply (сам текст —
 *  то же, что было передано в неё, включая склейку дебаунса). */
export async function queuePendingAiReply(contactId: string, text: string): Promise<void> {
  if (await isBotFrozen()) return;
  if (!text) return;
  const lastIn = await prisma.message.findFirst({
    where: { contactId, direction: "IN" },
    orderBy: { createdAt: "desc" },
  });
  const snapshotAt = lastIn?.createdAt ?? new Date();
  // aiReply is also called by this queue: do not create a new retry row on each failure.
  const existing = await prisma.pendingAiReply.findFirst({ where: { contactId, snapshotAt } });
  if (existing) return;
  await prisma.pendingAiReply
    .create({ data: { contactId, text, snapshotAt } })
    .catch((err) => logError("aiReplyRetry:queue", err));
}

/** Занятость прохода — тот же приём, что у receiptRetry.ts: тик приходит раз в
 *  10 секунд, а один ход ИИ может занять существенно дольше. */

/** Один проход очереди. Дёргается тем же тиком, что и разносчик воронок. */
export async function retryPendingAiReplies(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("aiReplyRetry", runQueue);
}

async function runQueue(): Promise<void> {
  if (await isBotFrozen()) return;
  const due = await prisma.pendingAiReply.findMany({
    where: { nextAttemptAt: { lte: new Date() } },
    include: { contact: true },
    orderBy: { createdAt: "asc" },
    take: 3,
  });

  for (const row of due) {
    if (await isBotFrozen()) return;
    // WhatsApp retries belong to its durable inbox and require the original incoming turn.
    if (row.contact.channel === "WHATSAPP" || (row.contact.personal || row.contact.spamBlockedAt || row.contact.whatsappSavedContact || row.contact.humanTakenOverAt)) {
      await prisma.pendingAiReply.delete({ where: { id: row.id } });
      continue;
    }
    // Пришло более свежее входящее с момента постановки — эта попытка устарела:
    // новое сообщение либо уже своя запись в очереди, либо на него уже ответили
    // обычным ходом. Повторять СТАРЫЙ текст поверх нового разговора нельзя.
    const newerIn = await prisma.message.findFirst({
      where: { contactId: row.contactId, direction: "IN", createdAt: { gt: row.snapshotAt } },
    });
    if (newerIn) {
      await prisma.pendingAiReply.delete({ where: { id: row.id } }).catch(() => null);
      continue;
    }

    // Кто-то (хозяйка руками, обычный ход) уже ответил после — сдачу засчитываем
    // как успех, а не как повод пробовать снова поверх готового ответа.
    const answeredSince = await prisma.message.findFirst({
      where: { contactId: row.contactId, direction: "OUT", text: { notIn: Object.values(DELAY_NOTICES) }, createdAt: { gt: row.snapshotAt } },
    });
    if (answeredSince) {
      await prisma.pendingAiReply.delete({ where: { id: row.id } }).catch(() => null);
      continue;
    }

    // Хозяйка прямо сейчас ведёт разговор сама (эхо-событие Instagram) — не
    // мешаем, сдвигаем попытку на момент, когда её пауза закончится, и не
    // тратим на это ни одной из ограниченных попыток.
    if (row.contact.humanSilencedUntil && row.contact.humanSilencedUntil.getTime() > Date.now()) {
      await prisma.pendingAiReply
        .update({ where: { id: row.id }, data: { nextAttemptAt: row.contact.humanSilencedUntil } })
        .catch(() => null);
      continue;
    }

    try {
      await aiReply(row.contact, row.text, [], []);
    } catch (err) {
      logError("aiReplyRetry:attempt", err);
      if (!canRetryMetaFailure(err)) {
        await notifyOwnerDirect(`Ответ для ${row.contactId} остановлен. Проверьте переписку перед повтором: ${err instanceof Error ? err.message : "неповторяемая ошибка"}`);
        await prisma.pendingAiReply.delete({ where: { id: row.id } });
        continue;
      }
    }

    if (await isBotFrozen()) return;
    const sentNow = await prisma.message.findFirst({
      where: { contactId: row.contactId, direction: "OUT", text: { notIn: Object.values(DELAY_NOTICES) }, createdAt: { gt: row.snapshotAt } },
    });
    if (sentNow) {
      await prisma.pendingAiReply.delete({ where: { id: row.id } }).catch(() => null);
      continue;
    }

    const attempts = row.attempts + 1;
    if (attempts >= 2 && !row.delayNoticeAt) {
      // Claim before sending: a timeout is ambiguous, so never resend this notice blindly.
      const claimed = await prisma.pendingAiReply.updateMany({
        where: { id: row.id, delayNoticeAt: null }, data: { delayNoticeAt: new Date() },
      });
      if (claimed.count) {
        const notice = DELAY_NOTICES[detectClientLanguage(row.text)];
        try {
          const mid = await sendToContact(row.contact, notice);
          await recordOutgoingMessage(row.contactId, notice, mid);
        } catch (error) { logError("aiReplyRetry:notice", error); }
        await giveUp(row.contactId, row.text, true);
      }
    }
    if (attempts >= MAX_ATTEMPTS) {
      await giveUp(row.contactId, row.text);
      await prisma.pendingAiReply.delete({ where: { id: row.id } }).catch(() => null);
      continue;
    }
    await prisma.pendingAiReply
      .update({ where: { id: row.id }, data: { attempts, nextAttemptAt: new Date(Date.now() + delayFor(attempts)) } })
      .catch(() => null);
  }
}

/** Попытки кончились (~13 часов) — сообщаем владельцу, а не молчим, как раньше. */
async function giveUp(contactId: string, text: string, early = false): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  // Техническое: только владельцу (telegramTechChatId), не сестре.
  const { techChatIds } = await import("./telegram.js");
  const recipients = await techChatIds();
  if (recipients.length === 0) return;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  const who = contact?.username ? `@${contact.username}` : contact?.igUserId;
  const message =
    (early ? "ИИ дважды не смог ответить. Вопрос сохранён, нужен человек.\n" : "ИИ не смог ответить за всё время повтора (~13 часов).\n") +
    `Человек: ${who}\n` +
    `Последнее: «${text.slice(0, 200)}»\n` +
    `Ответьте, пожалуйста, вручную.`;

  const { sendTelegramMessage } = await import("./telegram.js");
  for (const chatId of recipients) {
    await sendTelegramMessage(botToken, chatId, message).catch((err) => logError("aiReplyRetry:notify", err));
  }
}
