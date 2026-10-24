import { prisma, getSetting, logError } from "../db.js";
import { isBudgetExceeded, recordAiCall } from "../ai/dailyBudget.js";
import { sendTelegramMessage } from "../telegram.js";
import { findQaAnswer } from "../ai/qaGroupReply.js";
import { answerFromRecipes } from "./assistant.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import type { CourseChatMessage, Purchase } from "@prisma/client";
import { isBotFrozen } from "../messaging/automation.js";

/**
 * ЧАТ УЧЕНИЦЫ С УЧИТЕЛЬНИЦЕЙ.
 *
 * Вопрос проходит три ступени, от самой надёжной к самой слабой:
 *  1. АРХИВ ЖИВЫХ ОТВЕТОВ. Ширин уже отвечала на близко совпавший вопрос в
 *     учебной группе — повторяем её слова дословно. Это лучший ответ из всех
 *     возможных: он проверен ею самой.
 *  2. ПОМОЩНИК ПО РЕЦЕПТАМ. Отвечает строго по тексту рецептов, написанному
 *     владелицей, и обязан молчать, если ответа там нет (см. assistant.ts).
 *  3. ЖИВАЯ ШИРИН. Вопрос уходит ей в Telegram, ответ реплаем возвращается сюда.
 *
 * Ни на одной ступени бот не сочиняет от себя. Выдуманная замена продукта или
 * температура портят десерт, а вместе с ним доверие к школе — это дороже, чем
 * час ожидания живого ответа.
 */

/** Сколько последних сообщений отдаём в ленту. Разговор про уроки короткий,
 *  прокручивать сотни сообщений незачем. */
const HISTORY_LIMIT = 100;

/** Лента одна на человека: сообщения по всем его покупкам вперемешку по времени. */
export async function chatHistory(purchaseIds: string[]): Promise<CourseChatMessage[]> {
  if (purchaseIds.length === 0) return [];
  const rows = await prisma.courseChatMessage.findMany({
    where: { purchaseId: { in: purchaseIds } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  return rows.reverse();
}

/**
 * Приём вопроса. Возвращает обновлённую ленту, чтобы телефон нарисовал и свой
 * вопрос, и мгновенный ответ бота одним ответом сервера — на плохой связи
 * каждый лишний запрос это лишняя секунда ожидания.
 */
export async function receiveQuestion(
  purchase: Purchase,
  text: string,
  lessonId: string | null,
  queuedOffline: boolean,
  /** Чьи покупки показать в ответной ленте; по умолчанию — только эту. */
  historyFor: string[] = [purchase.id]
): Promise<CourseChatMessage[]> {
  await prisma.courseChatMessage.create({
    data: { purchaseId: purchase.id, lessonId, fromStudent: true, text, queuedOffline },
  });

  if (await isBotFrozen()) return chatHistory(historyFor);
  const auto = await autoAnswer(purchase, text, lessonId);
  if (await isBotFrozen()) return chatHistory(historyFor);
  if (auto) {
    await prisma.courseChatMessage.create({
      data: { purchaseId: purchase.id, lessonId, fromStudent: false, text: auto, byBot: true },
    });
  } else {
    await askOwner(purchase, text, lessonId);
  }

  return chatHistory(historyFor);
}

/**
 * Две первые ступени ответа. Обе под одним тумблером `qaAutoReplyEnabled`:
 * владелец включает автоответ один раз и сразу везде, а не ищет вторую галочку.
 * Выключен — бот молчит и зовёт Ширин, как было до платформы.
 */
/** Больше вопросов в час от одной покупки — уже не учёба, а скрипт. */
const HOURLY_CAP = 20;

async function autoAnswer(purchase: Purchase, text: string, lessonId: string | null): Promise<string | null> {
  if (await isBotFrozen()) return null;
  const enabled = (await getSetting("qaAutoReplyEnabled"))?.trim() === "true";
  if (!enabled) return null;

  // ТОТ ЖЕ СУТОЧНЫЙ БЮДЖЕТ, ЧТО У БОТА В INSTAGRAM. Раньше чат платформы шёл в
  // Gemini мимо него: одна ученица (или скрипт с одной живой кукой) в цикле
  // выжигала ключи в 429, счётчик бюджета этого не видел, и в день с
  // рекламой бот молчал для всех лидов, а по логам это выглядело как «Gemini
  // сломался» (разбор безопасности 03.09.2026). Исчерпан — зовём Ширин.
  if (await isBudgetExceeded(purchase.contactId)) return null;
  const lastHour = await prisma.courseChatMessage.count({
    where: { purchaseId: purchase.id, fromStudent: true, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
  });
  if (lastHour > HOURLY_CAP) return null;

  // Ступень 1: её собственный прошлый ответ. Всегда важнее помощника —
  // это живые слова учительницы, а не пересказ рецепта.
  try {
    // findQaAnswer отдаёт САМ пример из архива; ученице уходит только текст
    // ответа Ширин, без её вопроса и служебных полей.
    const example = await findQaAnswer(text);
    if (example?.ownerText) return example.ownerText;
  } catch (err) {
    // Сбой поиска не должен съесть вопрос: идём дальше по ступеням.
    logError("courseChat:autoAnswer", err);
  }

  // Ступень 2: помощник по рецептам этого курса. Молчит, если в материалах
  // ответа нет, — тогда ниже позовём Ширин.
  if (!purchase.courseId) return null;
  try {
    const answer = await answerFromRecipes(purchase.courseId, text, detectClientLanguage(text), lessonId);
    await recordAiCall(purchase.contactId);
    return answer.text;
  } catch (err) {
    logError("courseChat:assistant", err);
    return null;
  }
}

/** Переслать вопрос владельцу. Отвечать он будет реплаем — по message_id мы
 *  найдём, к какому вопросу относится ответ (см. telegramWebhook). */
async function askOwner(purchase: Purchase, text: string, lessonId: string | null): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await getSetting("telegramQaGroupId"))?.trim() || (await getSetting("telegramOwnerChatId"))?.trim();
  if (!botToken || !chatId) return;

  const [contact, lesson] = await Promise.all([
    prisma.contact.findUnique({ where: { id: purchase.contactId } }),
    lessonId ? prisma.lesson.findUnique({ where: { id: lessonId } }) : Promise.resolve(null),
  ]);
  const who = contact?.username ? `@${contact.username}` : (contact?.igUserId ?? "ученица");
  const about = lesson ? `\nУрок: ${lesson.title}` : "";

  // Запоминаем message_id: по нему ответ реплаем найдёт дорогу обратно
  // к вопросу этой ученицы (см. answerFromOwner).
  const messageId = await sendTelegramMessage(
    botToken,
    chatId,
    `❓ Вопрос с платформы от ${who}${about}\n\n${text}\n\nОтветьте на это сообщение — ответ уйдёт ей в приложение.`
  ).catch((err) => {
    logError("courseChat:askOwner", err);
    return null;
  });
  if (!messageId) return;
  const last = await prisma.courseChatMessage.findFirst({
    where: { purchaseId: purchase.id, fromStudent: true },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    await prisma.courseChatMessage
      .update({ where: { id: last.id }, data: { telegramMsgId: messageId } })
      .catch((err) => logError("courseChat:linkTelegram", err));
  }
}

/**
 * Ответ владельца реплаем в Telegram. Возвращает true, если реплай относился к
 * вопросу с платформы — тогда Telegram-обработчик не должен трактовать его как
 * обычное сообщение учебной группы.
 */
export async function answerFromOwner(replyToMessageId: number, text: string): Promise<boolean> {
  const question = await prisma.courseChatMessage.findFirst({
    where: { telegramMsgId: replyToMessageId, fromStudent: true },
  });
  if (!question) return false;
  await recordOwnerAnswer(question, text);
  return true;
}

/**
 * Ответ владельца из ПАНЕЛИ (inbox вопросов, 05.09.2026) — по id вопроса.
 * Та же запись, что у реплая в Telegram (recordOwnerAnswer): ученица получает
 * ответ одинаково, откуда бы Ширин ни отвечала. null — вопроса нет или это не
 * вопрос ученицы.
 */
export async function answerFromPanel(questionId: string, text: string): Promise<CourseChatMessage | null> {
  const question = await prisma.courseChatMessage.findFirst({ where: { id: questionId, fromStudent: true } });
  if (!question) return null;
  return recordOwnerAnswer(question, text);
}

export type PanelDraft =
  | { draft: string; source: string }
  | { draft: null; reason: "not_found" | "no_course" | "budget" | "no_material" | "unavailable" };

/**
 * ЧЕРНОВИК ОТВЕТА ДЛЯ ПАНЕЛИ («Утро Ширин» §6, волна 2). Тот же помощник по
 * рецептам, что отвечает ученице автоматически (ступень 2 выше), но здесь он
 * НИЧЕГО НЕ ОТПРАВЛЯЕТ: текст ложится в поле ответа, Ширин правит и жмёт
 * «Отправить» сама. Поэтому автоответ может быть выключен, а черновик — всё
 * равно доступен: решение остаётся за человеком.
 *
 * Бюджет — тот же суточный, что у бота (isBudgetExceeded/recordAiCall):
 * черновики из панели не должны выжигать квоту, которой отвечают лидам.
 * `source` — короткая пометка, по чему собран ответ («по рецепту урока 7»):
 * владелица должна видеть, откуда взялись граммовки, прежде чем отправить.
 */
export async function draftFromPanel(questionId: string): Promise<PanelDraft> {
  const question = await prisma.courseChatMessage.findFirst({
    where: { id: questionId, fromStudent: true },
    include: { purchase: { select: { contactId: true, courseId: true } }, lesson: { select: { order: true, title: true } } },
  });
  if (!question?.text?.trim()) return { draft: null, reason: "not_found" };
  if (!question.purchase.courseId) return { draft: null, reason: "no_course" };
  if (await isBudgetExceeded(question.purchase.contactId)) return { draft: null, reason: "budget" };

  const text = question.text;
  const answer = await answerFromRecipes(question.purchase.courseId, text, detectClientLanguage(text), question.lessonId);
  if (answer.text === null) return { draft: null, reason: answer.reason };
  await recordAiCall(question.purchase.contactId);
  const source = question.lesson
    ? `по рецепту урока ${question.lesson.order} «${question.lesson.title}»`
    : "по рецептам и расшифровкам курса";
  return { draft: answer.text, source };
}

/** Общий хвост обоих путей ответа: кладём ответ в ленту, вопрос помечаем прочитанным. */
async function recordOwnerAnswer(question: CourseChatMessage, text: string): Promise<CourseChatMessage> {
  const answer = await prisma.courseChatMessage.create({
    data: {
      purchaseId: question.purchaseId,
      lessonId: question.lessonId,
      fromStudent: false,
      text,
      byBot: false,
    },
  });
  await prisma.courseChatMessage
    .update({ where: { id: question.id }, data: { readByOwnerAt: new Date() } })
    .catch((err) => logError("courseChat:markRead", err));
  return answer;
}

/** Сколько вопросов ждут ответа — красная точка в панели владельца.
 *  `olderThan` — только те, что ждут дольше (напоминание владельцу, ownerReminder.ts). */
export async function unansweredCount(olderThan?: Date): Promise<number> {
  return prisma.courseChatMessage.count({
    where: { fromStudent: true, readByOwnerAt: null, ...(olderThan ? { createdAt: { lte: olderThan } } : {}) },
  });
}
