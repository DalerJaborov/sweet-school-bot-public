import { prisma } from "../db.js";
import type { Course } from "../courses.js";
import { COURSE_TITLE } from "../prices.js";

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

const MANUAL_LINK_ALL = /(?:https?:\/\/)?[^\s]*\/l\/[A-Za-z0-9_-]{10,}|(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)[\w-]+/gi;

/** Настоящие ссылки, которые Ширин вручную присылала клиентке, ПОШТУЧНО (по возрастанию времени). */
export async function manualLinks(contactId: string, since: Date): Promise<{ url: string; at: Date }[]> {
  // ПОСЛЕДНИЕ 50 сообщений (по убыванию) и разворот: иначе длинная переписка с
  // Ширин теряет свежую ссылку (ревью PR 72).
  const latest = await prisma.message.findMany({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: since }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { text: true, createdAt: true },
  });
  const rows = [...(latest ?? [])].reverse();
  const out: { url: string; at: Date }[] = [];
  for (const m of rows) {
    for (const hit of (m.text ?? "").match(MANUAL_LINK_ALL) ?? []) out.push({ url: hit, at: m.createdAt });
  }
  return out;
}

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
      OR: [{ inviteLink: { not: null } }, { accessIssuedAt: { not: null } }],
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
    select: { id: true, createdAt: true, inviteLink: true, course: true },
  });
  if (!waiting || waiting.length === 0) return false;
  const settled: string[] = [];
  const open = waiting.filter((p) => !p.inviteLink);
  for (const p of waiting) if (p.inviteLink) settled.push(p.id);
  // Каждая ручная ссылка "тратится" один раз (ревью PR 72): закрывает не больше одной
  // покупки - последней, созданной до неё, - и её адрес записывается в покупку, так что
  // следующие проверки эту ссылку уже не учитывают. Две ссылки в одном сообщении
  // закрывают две покупки.
  const at = (d: Date | undefined | null): number => (d instanceof Date ? d.getTime() : 0);
  // Потраченные ссылки НЕ пишем в inviteLink (по нему groupAccess ищет, кто вошёл в
  // группу, и отзывает доступ): считаем без состояния. Уже закрытые вручную покупки
  // (accessIssuedAt есть, inviteLink нет) расходуют столько же первых ссылок.
  const manualDone = await prisma.purchase.findMany({
    where: { contactId, revokedAt: null, inviteLink: null, accessIssuedAt: { not: null } },
    select: { createdAt: true },
  });
  const since = new Date(Math.min(...waiting.map((p) => at(p.createdAt)), ...(manualDone ?? []).map((p) => at(p.createdAt))));
  const spentCount = (manualDone ?? []).length;
  const links = (await manualLinks(contactId, since)).slice(spentCount);
  for (const l of links) {
    const candidates = open.filter((p) => !settled.includes(p.id) && at(p.createdAt) <= at(l.at));
    candidates.sort((x, y) => at(y.createdAt) - at(x.createdAt));
    if (candidates[0]) settled.push(candidates[0].id);
  }
  if (settled.length === 0) return false;
  // accessIssuedAt: метка "выдано вручную" - планировщик не считает курс недоставленным
  for (const id of settled) {
    await prisma.purchase.update({ where: { id }, data: { deliveryAwaitingChoice: false, accessIssuedAt: new Date() } });
  }
  // Ссылка Ширин не привязана к курсу (и может вести в бесплатную группу): после
  // снятия вопроса владельцу уходит напоминание проверить, что ссылка нужная.
  const leftover = waiting.filter((p) => !settled.includes(p.id));
  if (waiting.some((p) => settled.includes(p.id) && !p.inviteLink)) {
    await tellOwnerChoiceSettled(contactId, leftover.map((p) => p.course));
  }
  if (leftover.length > 0) {
    // Часть покупок ещё ждёт: вопрос про Telegram нужно задать заново (ответ "да" после
    // сообщения Ширин не засчитывается) - сбрасываем состояние вопроса.
    await prisma.contact.updateMany({ where: { id: contactId }, data: { deliveryChoicePromptState: null, deliveryChoicePromptMid: null } });
  }
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

async function tellOwnerChoiceSettled(contactId: string, stillWaiting: string[] = []): Promise<void> {
  try {
    const tg = await import("../telegram.js");
    const { getSetting } = await import("../db.js");
    const botToken = (await getSetting("telegramBotToken"))?.trim();
    if (!botToken) return;
    const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { username: true, igUserId: true } });
    const who = c ? (c.username ? `@${c.username}` : c.igUserId) : contactId;
    const titles = stillWaiting.map((c) => COURSE_TITLE[c as keyof typeof COURSE_TITLE] ?? c).join(", ");
    const text =
      `${who}: вы прислали ссылку вручную, поэтому бот не стал спрашивать про Telegram. Проверьте, что это ссылка на оплаченный курс.` +
      (titles ? ` Ещё ждёт оплата за: ${titles} - ссылка по ней не выдана, бот спросит клиентку про Telegram заново (или выдайте ссылку кнопкой «Выдать ссылку»).` : "");
    for (const chatId of await tg.summaryChatIds()) await tg.sendTelegramMessage(botToken, chatId, text);
  } catch {
    // уведомление необязательно: главное - бот не пишет клиентке второй раз
  }
}
