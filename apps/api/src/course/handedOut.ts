import { prisma } from "../db.js";
import type { Course } from "../courses.js";

/**
 * «ДОСТУП УЖЕ ВЫДАН» - ЕДИНЫЙ ВОПРОС ДЛЯ АВТОМАТИКИ ПО ОПЛАТЕ (08.11.2026).
 *
 * Живой случай: Ширин сама выдала ссылку в Telegram, клиентка сказала «Рахмат»,
 * а через несколько минут отложенная перепроверка чека сработала и бот написал
 * «Пардохт қабул шуд. Шумо Telegram доред?» - человеку, который уже учится.
 * Один платёж - одна выдача.
 *
 * ПРАВИЛО ОСТОРОЖНОСТИ (ревью architect): молчание автоматики не должно терять
 * оплату. Поэтому:
 *  - «выдано» значит: действующая покупка именно на НУЖНЫЕ курсы с выданной
 *    ссылкой (inviteLink) после момента `since`; покупка другого курса не в счёт;
 *  - сообщение Ширин считается ссылкой только если в нём настоящая ссылка на
 *    уроки (/l/<токен>) или приглашение в группу (t.me/+...), а не рилс, сайт
 *    или упоминание аккаунта;
 *  - одного сообщения без покупки мало, чтобы тихо закрыть оплату: такой чек
 *    уходит владельцу с пометкой «возможно, уже выдано» ("maybe").
 */
const MANUAL_LINK = /\/l\/[A-Za-z0-9_-]{10,}|t\.me\/(?:\+|joinchat\/)[\w-]+/i;

export async function manualLinkSince(contactId: string, since: Date): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: since }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { text: true },
  });
  return (rows ?? []).some((m) => Boolean(m.text && MANUAL_LINK.test(m.text)));
}

/** Курсы с выданной ссылкой, купленные после `since`. */
export async function deliveredCoursesSince(contactId: string, since: Date): Promise<string[]> {
  const rows = await prisma.purchase.findMany({
    where: {
      contactId,
      revokedAt: null,
      accessDeliveryUncertainAt: null,
      inviteLink: { not: null },
      createdAt: { gte: since },
    },
    select: { course: true },
  });
  return (rows ?? []).map((r) => r.course);
}

export type ServedState = "served" | "maybe" | "no";

/**
 * Обслужен ли уже платёж на `courses` (то, что даёт сумма чека): "served" -
 * покупки на все эти курсы выданы; "maybe" - Ширин прислала настоящую ссылку, но
 * покупок на эти курсы нет (выдача вне системы) - молча закрывать нельзя;
 * "no" - автоматика работает как обычно.
 */
export async function receiptServedState(contactId: string, since: Date, courses: Course[]): Promise<ServedState> {
  if (courses.length === 0) return "no";
  const delivered = await deliveredCoursesSince(contactId, since);
  if (courses.every((c) => delivered.includes(c))) return "served";
  return (await manualLinkSince(contactId, since)) ? "maybe" : "no";
}

/**
 * Вопрос «есть ли Telegram?» ждёт ответа, но эта покупка уже выдана (у неё есть
 * ссылка) или Ширин прислала настоящую ссылку после покупки: снимаем ожидание
 * ТОЛЬКО у таких покупок. true - не осталось ни одной ждущей покупки.
 */
export async function settleChoiceIfHandedOut(contactId: string): Promise<boolean> {
  const waiting = await prisma.purchase.findMany({
    where: { contactId, revokedAt: null, deliveryAwaitingChoice: true },
    select: { id: true, createdAt: true, inviteLink: true },
  });
  if (!waiting || waiting.length === 0) return false;
  const settled: string[] = [];
  // Ссылка Ширин не привязана к курсу: по одному её сообщению снимаем ожидание,
  // только если ждёт ровно одна покупка (комплект из двух не трогаем).
  for (const p of waiting) {
    if (p.inviteLink || (waiting.length === 1 && (await manualLinkSince(contactId, p.createdAt)))) settled.push(p.id);
  }
  if (settled.length === 0) return false;
  await prisma.purchase.updateMany({ where: { id: { in: settled } }, data: { deliveryAwaitingChoice: false } });
  // Ссылка Ширин не привязана к курсу (и может вести в бесплатную группу): после
  // снятия вопроса владельцу уходит напоминание проверить, что ссылка нужная.
  if (waiting.some((p) => settled.includes(p.id) && !p.inviteLink)) await tellOwnerChoiceSettled(contactId);
  if (settled.length === waiting.length) {
    await prisma.receiptCheck.updateMany({
      where: { contactId, awaitingDeliveryChoice: true },
      // linkSent: платёж принят и обслужен вручную - проверки повторов и отчёт видят его
      data: { awaitingDeliveryChoice: false, linkSent: true },
    });
    return true;
  }
  return false;
}

async function tellOwnerChoiceSettled(contactId: string): Promise<void> {
  try {
    const tg = await import("../telegram.js");
    const { getSetting } = await import("../db.js");
    const botToken = (await getSetting("telegramBotToken"))?.trim();
    if (!botToken) return;
    const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { username: true, igUserId: true } });
    const who = c ? (c.username ? `@${c.username}` : c.igUserId) : contactId;
    const text = `${who}: вы прислали ссылку вручную, поэтому бот не стал спрашивать про Telegram. Проверьте, что это ссылка на оплаченный курс.`;
    for (const chatId of await tg.summaryChatIds()) await tg.sendTelegramMessage(botToken, chatId, text);
  } catch {
    // уведомление необязательно: главное - бот не пишет клиентке второй раз
  }
}
