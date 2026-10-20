import { Router } from "express";
import { handleManualLinkCommand } from "./course/manualLink.js";
import { handleWhatsappSignupCommand } from "./course/manualOfflineSignup.js";
import { z } from "zod";
import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { sendToContact } from "./messaging/send.js";
import { answerCallback, editCaption, editMessageText } from "./telegram.js";
import { handleChatMember } from "./groupAccess.js";
import { getQuickReplies } from "./quickReplies.js";
import { handleQaGroupMessage, type TgGroupMessage } from "./qaGroup.js";
import { answerFromOwner } from "./course/chat.js";
import { decideReceipt } from "./receiptDecision.js";

export const telegramRouter = Router();

type CallbackQuery = {
  id?: string;
  data?: string;
  from?: { id?: number };
  message?: { message_id?: number; chat?: { id?: number }; text?: string };
};

/**
 * Кому вообще позволено решать судьбу чека: только владелец и сестра — те же
 * chat_id, которым бот шлёт карточки. Без этой проверки любой POST на публичный
 * `/webhooks/telegram` подтверждал чек и отправлял клиенту ссылку на платный
 * курс — единственной преградой была неугадываемость id чека, а это не защита.
 */
async function isTrustedSender(query: CallbackQuery): Promise<boolean> {
  const allowed = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter(Boolean);
  if (allowed.length === 0) return false; // получатели не настроены — не доверяем никому
  const who = [query.from?.id, query.message?.chat?.id].filter((v) => v != null).map(String);
  return who.some((id) => allowed.includes(id));
}

/** Секрет, который Telegram обязан прислать в заголовке (задаётся при setWebhook).
 *  Пока он не настроен, дверь держит проверка чата ниже. */
async function secretOk(header: string | undefined): Promise<boolean> {
  const secret = (await getSetting("telegramWebhookSecret"))?.trim();
  if (!secret) return true;
  return header === secret;
}

/**
 * ЧУЖОЙ ЧАТ ДАЛЬШЕ НЕ ПУСКАЕМ.
 *
 * Разбор безопасности 03.09.2026: адрес вебхука открыт всему интернету, а
 * секрет заголовка настроить было физически нельзя — ключа не существовало в
 * списке настроек, и проверка всегда пропускала. При этом ветка обычных
 * сообщений не смотрела на отправителя вовсе. То есть кто угодно мог послать
 * нам выдуманное «сообщение от Ширин» и записать его ученице как ответ
 * учительницы, а при включённом автоответе — разослать выдумку дальше по
 * ученицам. Для кондитерской школы подделанный совет про температуру или
 * замену продукта хуже утечки.
 *
 * Разрешены только наши собственные чаты. Ни один не задан — не пускаем
 * никого: обработчики в таком состоянии всё равно ничего не делают, а
 * открытая дверь при пустых настройках это ровно та ошибка, что уже была.
 */
async function knownChat(message: { chat?: { id?: number | string } }): Promise<boolean> {
  const allowed = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
    (await getSetting("telegramQaGroupId"))?.trim(),
  ].filter(Boolean);
  if (allowed.length === 0) return false;
  const chatId = message.chat?.id;
  return chatId != null && allowed.includes(String(chatId));
}

/**
 * Нажатия кнопок «Подтвердить»/«Отклонить» под карточкой сомнительного чека.
 * Telegram шлёт их сюда вебхуком; адрес задаётся один раз (см. admin.ts,
 * /admin/telegram/setup).
 */
telegramRouter.post("/webhooks/telegram", async (req, res) => {
  res.sendStatus(200); // Telegram ждёт быстрый ответ, иначе повторит доставку
  await handleTelegramUpdate(req.body, req.header("x-telegram-bot-api-secret-token"));
});

/**
 * Разбор одного обновления, отдельно от express.
 *
 * Вынесено, чтобы проверки «чужой чат не пускаем» и «секрет не совпал» можно
 * было покрыть тестами: внутри обработчика маршрута до них было не добраться,
 * а именно они держат дверь.
 */
export async function handleTelegramUpdate(rawBody: unknown, secretHeader: string | undefined): Promise<void> {
  // Runtime-валидация верхней структуры: Telegram иногда меняет формат,
  // и без проверки неожиданные поля приводят к silent undefined-access.
  const BodySchema = z.object({
    chat_member: z.record(z.unknown()).optional(),
    message: z.record(z.unknown()).optional(),
    callback_query: z.object({
      id: z.string().optional(),
      data: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough();
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    logError("telegram:invalidPayload", new Error(`Malformed telegram webhook body: ${parsed.error.message}`));
    return;
  }
  const body = parsed.data;

  // Вход человека в закрытую группу по нашей ссылке — так узнаём его Telegram-id.
  const member = body.chat_member as Parameters<typeof handleChatMember>[0] | undefined;
  if (member) {
    if (await secretOk(secretHeader)) {
      await handleChatMember(member).catch((err) => logError("telegram:chatMember", err));
    }
    return;
  }

  // Обычное сообщение — не нажатие кнопки. Потребителей два: чат платформы
  // курсов и захват учебной группы (qaGroup.ts, сама решает, её ли это чат).
  const message = body.message as TgGroupMessage | undefined;
  if (message) {
    if ((await secretOk(secretHeader)) && (await knownChat(message))) {
      // Ответ РЕПЛАЕМ на вопрос с платформы уходит ученице в приложение и
      // дальше не идёт: в архив учебной группы он не относится, там своя пара
      // «вопрос — ответ», и такая запись засорила бы обучение.
      const replyTo = message.reply_to_message?.message_id;
      const text = (message.text ?? message.caption ?? "").trim();

      // Команда владельца «выдай ссылку руками» — раньше всего остального:
      // это её собственный чат, и вести её слова как вопрос ученицы незачем.
      if (await handleManualLinkCommand(message).catch((err) => {
        logError("telegram:manualLink", err);
        return false;
      })) {
        return;
      }

      // Запись из WhatsApp, пересланная или вписанная руками — тоже её команда,
      // проверяем до того, как сообщение уйдёт как вопрос ученицы в архив группы.
      if (await handleWhatsappSignupCommand(message).catch((err) => {
        logError("telegram:whatsappSignup", err);
        return false;
      })) {
        return;
      }

      const handledByCourse =
        replyTo && text
          ? await answerFromOwner(replyTo, text).catch((err) => {
              logError("telegram:courseChatReply", err);
              return false;
            })
          : false;
      if (!handledByCourse) {
        await handleQaGroupMessage(message).catch((err) => logError("telegram:qaGroup", err));
      }
    }
    return;
  }

  const query = body.callback_query as CallbackQuery | undefined;
  if (!query?.data || !query.id) return;

  try {
    if (!(await secretOk(secretHeader))) {
      logError("telegram:webhook", new Error("отклонён: неверный секрет заголовка"));
      return;
    }
    if (!(await isTrustedSender(query))) {
      logError("telegram:webhook", new Error("отклонён: кнопку нажал посторонний"));
      return;
    }
    await handleDecision(query);
  } catch (err) {
    logError("telegram:webhook", err);
  }
}

async function handleDecision(query: CallbackQuery): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;

  // Кнопка быстрого ответа под уведомлением «серой зоны» (не про курс, не про
  // рецепт) — отдельный формат callback_data, разбираем раньше ok/no. Не трогает
  // раскладку курсов/оплату ниже.
  if (query.data?.startsWith("qr:")) {
    await handleQuickReply(botToken, query);
    return;
  }

  // ok/no — обычная сумма прочиталась. c50/c70/cboth — сумма НЕ прочиталась,
  // владелец нажал явный выбор курса вместо угадывания (см. sendReceiptForReview
  // needsCourseChoice, решение владельца 25.08.2026 веч.).
  const match = /^(ok|no|c50|c70|cboth):(.+)$/.exec(query.data as string);
  if (!match) return;
  const [, action, receiptId] = match;
  const courseChoice = action === "c50" ? "COURSE50" : action === "c70" ? "COURSE70" : action === "cboth" ? "BOTH" : undefined;

  const receipt = await prisma.receiptCheck.findUnique({ where: { id: receiptId }, include: { contact: true } });
  if (!receipt) {
    await answerCallback(botToken, query.id as string, "Чек не найден");
    return;
  }
  const who = receipt.contact.username ? `@${receipt.contact.username}` : receipt.contact.igUserId;

  // Само решение (подтвердить/отклонить, раскладка курсов, отметка «оплатил») —
  // в receiptDecision.ts, общее с /admin/receipts/:id/decide в панели. Здесь
  // остаётся только карточка Telegram: answerCallback (тост нажавшему) и
  // finishCard (подпись под уже отправленной картинкой чека).
  const result = await decideReceipt(receiptId, action === "no" ? "reject" : "approve", courseChoice);
  await answerCallback(botToken, query.id as string, result.message);
  if (!result.ok) return; // «не найден» / «уже принято» / «нет группы» — карточка не меняется

  const icon = result.status === "rejected" ? "❌" : result.status === "approved" ? "✅" : "⚠️";
  const verb =
    result.status === "rejected"
      ? "получил просьбу прислать чек заново"
      : result.status === "approved"
        ? "получил ссылку на курс"
        : result.message;
  await finishCard(botToken, query, `${icon} ${who}: ${verb}`);
}

async function finishCard(botToken: string, query: CallbackQuery, caption: string): Promise<void> {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (chatId && messageId) await editCaption(botToken, chatId, messageId, caption);
}

/**
 * Нажатие кнопки быстрого ответа под уведомлением «просит человека» / заглушкой
 * офф-топика (см. ai.ts callOwnerToChat, quickReplies.ts). callback_data —
 * `qr:<contactId>:<index>`, индекс в список quickReplies, а не сам текст:
 * Telegram ограничивает callback_data 64 байтами.
 */
async function handleQuickReply(botToken: string, query: CallbackQuery): Promise<void> {
  const match = /^qr:([^:]+):(\d+)$/.exec(query.data as string);
  if (!match) return;
  const [, contactId, indexStr] = match;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    await answerCallback(botToken, query.id as string, "Контакт не найден");
    return;
  }

  const quickReplies = await getQuickReplies();
  const reply = quickReplies[Number(indexStr)];
  if (!reply) {
    await answerCallback(botToken, query.id as string, "Ответ не найден — список могли изменить");
    return;
  }

  // byHuman: это ответ Ширин, не бота. На сайте он покажется как «ответ
  // владельца» (site/router.ts: from="owner"); для Meta признак не пишется —
  // там его, как и раньше, ставит эхо вебхука.
  const mid = await sendToContact(contact, reply.text, [], { byHuman: true }).catch((err) => {
    logError("telegram:quickReply", err);
    return null;
  });
  await recordOutgoingMessage(contact.id, reply.text, mid);

  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  await answerCallback(botToken, query.id as string, "Отправлено клиенту");
  await finishQuickReplyCard(botToken, query, `✅ ${who} — отправлено: «${reply.label}»`);
}

/** Тот же приём, что finishCard, но для текстового сообщения: editMessageText,
 *  а не editMessageCaption. Исходный текст уведомления сохраняем — там
 *  последняя фраза клиента, это полезный контекст, — просто дописываем итог и
 *  убираем кнопки. */
async function finishQuickReplyCard(botToken: string, query: CallbackQuery, statusLine: string): Promise<void> {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;
  const original = query.message?.text;
  const text = original ? `${original}\n\n${statusLine}` : statusLine;
  await editMessageText(botToken, chatId, messageId, text);
}
