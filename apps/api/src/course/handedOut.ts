import { prisma, getSetting, logError } from "../db.js";
import { chatKeyFor, COURSE_TITLE, type Course } from "../courses.js";
import { notifyOwnerDirect } from "../systemAlerts.js";
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

/**
 * Настоящие ссылки, которые Ширин вручную присылала клиентке после `since`:
 * каждый адрес ОДИН раз (переслала ту же ссылку дважды - это одна ссылка), с
 * моментом ПЕРВОЙ отправки. Берём последние 200 сообщений Ширин: свежая ссылка
 * в длинной переписке не теряется (ревью PR 72).
 */
export async function manualLinks(contactId: string, since: Date): Promise<{ url: string; at: Date }[]> {
  const latest = await prisma.message.findMany({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: since }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { text: true, createdAt: true },
  });
  const rows = [...(latest ?? [])].reverse();
  const out = new Map<string, { url: string; at: Date }>();
  for (const m of rows) {
    for (const hit of (m.text ?? "").match(MANUAL_LINK_ALL) ?? []) {
      const url = hit.replace(/[.,!?)»"']+$/u, "");
      const key = linkKey(url);
      if (!out.has(key)) out.set(key, { url, at: m.createdAt });
    }
  }
  return [...out.values()];
}

/** Один адрес - один ключ: с https:// и без, в любом регистре домена. */
function linkKey(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^(www\.)/i, "");
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
 * Вопрос «есть ли Telegram?» ждёт ответа, но покупка уже выдана (у неё есть
 * ссылка) или Ширин прислала ссылку, которая ПРАВДА открывает этот курс этому
 * человеку: снимаем ожидание ТОЛЬКО у таких покупок. true - не осталось ни одной
 * ждущей покупки.
 *
 * ДЕНЬГИ (ревью PR 72): раньше ссылка не сверялась с курсом - клиентка купила оба
 * курса, Ширин прислала группу «Арт-десерты», а закрывался «21 рецепт» (последняя
 * покупка); бот потом слал ещё раз не тот курс, а «21 рецепт» не приходил никогда.
 * Теперь каждая ссылка сверяется manualLinkServesCourse:
 *  - личная ссылка сайта ЭТОГО человека (/l/<код>) открывает все его курсы -
 *    закрывает все покупки, созданные до неё;
 *  - приглашение в группу (из панели) закрывает только покупку своего курса;
 *  - незнакомая ссылка (создана в самом Telegram, чужая, просроченная) не закрывает
 *    ничего: Далеру одна строка «сверьте», без повторов.
 * Покупка на курс одна (уникальность в базе), поэтому повтор той же ссылки не
 * закроет вторую покупку.
 */
export async function settleChoiceIfHandedOut(contactId: string): Promise<boolean> {
  const waiting = await prisma.purchase.findMany({
    where: { contactId, revokedAt: null, deliveryAwaitingChoice: true },
    select: { id: true, createdAt: true, inviteLink: true, course: true },
  });
  if (!waiting || waiting.length === 0) return false;
  const at = (d: Date | undefined | null): number => (d instanceof Date ? d.getTime() : 0);
  const settled = new Set<string>(waiting.filter((p) => p.inviteLink).map((p) => p.id));
  const open = waiting.filter((p) => !p.inviteLink);
  const unverified: string[] = [];
  if (open.length > 0) {
    const since = new Date(Math.min(...open.map((p) => at(p.createdAt))));
    for (const link of await manualLinks(contactId, since)) {
      const before = open.filter((p) => at(p.createdAt) <= at(link.at));
      if (before.length === 0) continue;
      let served = false;
      for (const p of before) {
        if (await manualLinkServesCourse(contactId, link.url, p.course as Course).catch(() => false)) {
          settled.add(p.id);
          served = true;
        }
      }
      if (!served) unverified.push(link.url);
    }
  }
  const leftover = waiting.filter((p) => !settled.has(p.id));
  if (unverified.length > 0 && leftover.length > 0) await reportUnverifiedLinks(contactId, unverified, leftover);
  if (settled.size === 0) return false;
  // accessIssuedAt: метка "выдано вручную" - планировщик не считает курс недоставленным
  // (courses.awaitsBotDelivery). Адрес в inviteLink НЕ пишем: по нему groupAccess ищет,
  // кто вошёл в группу.
  for (const p of waiting) {
    if (!settled.has(p.id)) continue;
    await prisma.purchase.update({
      where: { id: p.id },
      data: { deliveryAwaitingChoice: false, ...(p.inviteLink ? {} : { accessIssuedAt: new Date() }) },
    });
  }
  // Владельцу про закрытые ручной ссылкой не пишем (11.11.2026: шум).
  if (leftover.length > 0) {
    // Часть покупок ещё ждёт: вопрос про Telegram нужно задать заново (ответ "да" после
    // сообщения Ширин не засчитывается) - сбрасываем состояние вопроса.
    await prisma.contact.updateMany({ where: { id: contactId }, data: { deliveryChoicePromptState: null, deliveryChoicePromptMid: null } });
    return false;
  }
  await prisma.receiptCheck.updateMany({
    where: { contactId, awaitingDeliveryChoice: true },
    // linkSent: платёж принят и обслужен вручную - проверки повторов и отчёт видят его
    data: { awaitingDeliveryChoice: false, linkSent: true },
  });
  return true;
}

/** Ссылку Ширин не удалось сверить с курсом: оплату не закрываем, Далеру одна
 *  строка на ссылку (тех-чат, как в receiptVerdict.settleManualHandout). */
async function reportUnverifiedLinks(contactId: string, links: string[], leftover: { course: string }[]): Promise<void> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { username: true, igUserId: true } });
  const who = contact?.username ? `@${contact.username}` : (contact?.igUserId ?? contactId);
  const titles = leftover.map((p) => COURSE_TITLE[p.course as Course] ?? p.course).join(", ");
  for (const link of links) {
    await notifyOwnerDirect(
      `${who}: Ширин прислала ссылку вручную, но бот не узнал, в какой она курс. Ждёт выдачи: ${titles}. ` +
        "Если доступ уже выдан - сверьте группу; иначе бот спросит про Telegram и выдаст сам.",
      { dedupeKey: `manual-link-unverified:${contactId}:${linkKey(link)}`, cooldownMs: 30 * 24 * 3_600_000 },
    ).catch((err) => logError("handedOut:unverifiedLink", err));
  }
}
