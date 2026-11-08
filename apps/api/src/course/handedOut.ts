import { prisma } from "../db.js";

/**
 * «ДОСТУП УЖЕ ВЫДАН» - ЕДИНЫЙ ВОПРОС ДЛЯ ВСЕЙ АВТОМАТИКИ ПО ОПЛАТЕ (08.11.2026).
 *
 * Живой случай: Ширин сама выдала ссылку в Telegram, клиентка сказала «Рахмат»,
 * а через несколько минут отложенная перепроверка чека сработала и бот написал
 * «Пардохт қабул шуд. Шумо Telegram доред?» - человеку, который уже учится.
 * Один платёж - одна выдача: любое автоматическое сообщение про оплату, вопрос о
 * способе доставки и отложенное одобрение сначала спрашивают здесь.
 *
 * Доступ считается выданным, если с момента `since`:
 *  - у человека появилась или получила ссылку действующая покупка, ИЛИ
 *  - живой человек (Ширин) написал ему сообщение со ссылкой.
 * Простое «Ширин что-то ответила» без ссылки сюда не входит: платёж мог
 * остаться неоткрытым, молчать автоматике тогда нельзя.
 */
const LINK_IN_TEXT = /https?:\/\/|t\.me\/|\bshirinsweets\b/i;

export async function accessAlreadyHandedOut(contactId: string, since: Date): Promise<boolean> {
  const delivered = await prisma.purchase.findFirst({
    where: {
      contactId,
      revokedAt: null,
      accessDeliveryUncertainAt: null,
      OR: [{ createdAt: { gte: since }, inviteLink: { not: null } }, { accessIssuedAt: { gte: since } }],
    },
    select: { id: true },
  });
  if (delivered) return true;
  const human = await prisma.message.findFirst({
    where: { contactId, direction: "OUT", byHuman: true, createdAt: { gte: since }, text: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { text: true },
  });
  return Boolean(human?.text && LINK_IN_TEXT.test(human.text));
}

/**
 * Вопрос «есть ли Telegram?» ждёт ответа, но доступ уже выдан руками: снимаем
 * ожидание выбора, чтобы бот не спрашивал и не слал вторую ссылку. true -
 * ожидание снято.
 */
export async function settleChoiceIfHandedOut(contactId: string): Promise<boolean> {
  const first = await prisma.purchase.findFirst({
    where: { contactId, revokedAt: null, deliveryAwaitingChoice: true },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) return false;
  if (!(await accessAlreadyHandedOut(contactId, first.createdAt))) return false;
  await prisma.purchase.updateMany({ where: { contactId, deliveryAwaitingChoice: true }, data: { deliveryAwaitingChoice: false } });
  await prisma.receiptCheck.updateMany({ where: { contactId, awaitingDeliveryChoice: true }, data: { awaitingDeliveryChoice: false } });
  return true;
}
