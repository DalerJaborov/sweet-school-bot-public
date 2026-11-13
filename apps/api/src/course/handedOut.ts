import { prisma, getSetting } from "../db.js";
import { chatKeyFor, type Course } from "../courses.js";
import { findPanelInviteByLink } from "../links/telegramInvites.js";

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

const LINK_IN_TEXT = /https?:\/\/\S*(?:\/l\/[A-Za-z0-9_-]{10,}|t\.me\/(?:\+|joinchat\/)[\w-]+)\S*|t\.me\/(?:\+|joinchat\/)[\w-]+/gi;

/** Настоящие ссылки на уроки, которые Ширин прислала руками после `since` (новые первыми, без повторов). */
export async function manualLinksSince(contactId: string, since: Date): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: since }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { text: true },
  });
  const links: string[] = [];
  for (const m of rows ?? []) {
    for (const hit of (m.text ?? "").matchAll(LINK_IN_TEXT)) {
      const link = hit[0].replace(/[.,!?)»"']+$/u, "");
      if (!links.includes(link)) links.push(link);
    }
  }
  return links;
}

/**
 * ДЕНЬГИ: ЧЬЯ ЭТО ССЫЛКА И В КАКУЮ ГРУППУ (ревью 11.11.2026). Ширин выдала ссылку
 * сама — прежде чем молча закрыть оплату, сверяем, что ссылка правда открывает
 * оплаченный курс именно этому человеку:
 *  - сайт /l/<код> — код личной ссылки ЭТОГО человека (на сайте по ней открываются
 *    все его оплаченные курсы, значит и тот, что закрываем сейчас);
 *  - t.me/+… — приглашение, созданное ботом из панели (TelegramInvite): группа =
 *    группа этого курса, ссылка не отозвана и не просрочена, выдана не другому человеку.
 * Ссылку Ширин создала в самом Telegram (в базе её нет), чужая, общая или в другую
 * группу — false: оплату отмечаем, но ссылку к покупке не пишем и просим сверить.
 */
export async function manualLinkServesCourse(contactId: string, link: string, course: Course): Promise<boolean> {
  const site = /\/l\/([A-Za-z0-9_-]{10,})/.exec(link);
  if (site) {
    const code = site[1];
    const owner =
      (await prisma.contact.findUnique({ where: { accessTokenId: code }, select: { id: true } }))?.id ??
      (await prisma.purchase.findUnique({ where: { accessTokenId: code }, select: { contactId: true } }))?.contactId ??
      null;
    return owner === contactId;
  }
  const invite = await findPanelInviteByLink(link);
  if (!invite || invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return false;
  if (invite.contactId && invite.contactId !== contactId) return false;
  const chatId = (await getSetting(chatKeyFor(course)))?.trim();
  return Boolean(chatId) && invite.chatId === chatId;
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
  // Владельцу про это не пишем (11.11.2026: «вы прислали ссылку вручную... проверьте» - шум).
  const leftover = waiting.filter((p) => !settled.includes(p.id));
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
