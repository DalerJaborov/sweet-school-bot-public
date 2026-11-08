import { prisma, getSetting, logError } from "./db.js";
import { editCaption } from "./telegram.js";
import { coursesForAmount } from "./courses.js";
import { deliveredCoursesSince } from "./course/handedOut.js";

/**
 * КАРТОЧКИ ЧЕКОВ В TELEGRAM: ЗАПОМНИТЬ И ЗАКРЫТЬ (08.11.2026).
 *
 * Живой случай: клиентка прислала чек, бот отправил Ширин карточку с кнопками
 * «Подтвердить/Отклонить», Ширин выдала ссылку руками — а карточка осталась с
 * живыми кнопками. Нажатие потом либо ничего не меняло, либо упиралось в
 * «уже есть/отозвано», и казалось, что кнопки сломаны.
 *
 * Теперь:
 *  • при отправке карточки её адрес (чат + номер сообщения) пишется в
 *    ReceiptCheck.ownerAlerts;
 *  • если доступ уже выдан другим путём (покупка создана руками, Ширин
 *    написала клиентке ссылку), чек закрывается как HANDLED, а карточка
 *    переписывается без кнопок;
 *  • то же при нажатии устаревшей кнопки (см. telegramWebhook.ts).
 */

export type OwnerAlert = { chatId: string; messageId: number };

export function parseAlerts(raw: string | null | undefined): OwnerAlert[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (a): a is OwnerAlert =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as OwnerAlert).chatId === "string" &&
        typeof (a as OwnerAlert).messageId === "number",
    );
  } catch {
    return [];
  }
}

/** Дописать адрес отправленной карточки к чеку. */
export async function rememberAlert(receiptId: string, alert: OwnerAlert): Promise<void> {
  try {
    const row = await prisma.receiptCheck.findUnique({ where: { id: receiptId }, select: { ownerAlerts: true } });
    const list = parseAlerts(row?.ownerAlerts);
    if (list.some((a) => a.chatId === alert.chatId && a.messageId === alert.messageId)) return;
    list.push(alert);
    await prisma.receiptCheck.update({ where: { id: receiptId }, data: { ownerAlerts: JSON.stringify(list) } });
  } catch (err) {
    logError("receiptAlerts:remember", err);
  }
}

/** Переписать подпись всех карточек чека и убрать кнопки. */
export async function closeCards(receipt: { ownerAlerts: string | null }, caption: string): Promise<void> {
  const alerts = parseAlerts(receipt.ownerAlerts);
  if (alerts.length === 0) return;
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  for (const a of alerts) await editCaption(botToken, a.chatId, a.messageId, caption);
}

function whoOf(contact: { username: string | null; igUserId: string }): string {
  return contact.username ? `@${contact.username}` : contact.igUserId;
}

/**
 * Закрыть ожидающие чеки человека: доступ он уже получил. Возвращает, сколько
 * чеков закрыто. Атомарно (условие в WHERE): нажатие кнопки владельцем и
 * автозакрытие одновременно не выдадут решение дважды.
 */
export async function closeReceiptAlerts(contactId: string, how: string): Promise<number> {
  return closeRows({ contactId, ownerDecision: "PENDING" }, how);
}

export async function closeReceiptById(id: string, how: string): Promise<number> {
  return closeRows({ id, ownerDecision: "PENDING" }, how);
}

async function closeRows(where: { id?: string; contactId?: string; ownerDecision: string }, how: string): Promise<number> {
  const rows = await prisma.receiptCheck.findMany({
    where,
    include: { contact: true },
  });
  let closed = 0;
  for (const row of rows) {
    const claim = await prisma.receiptCheck.updateMany({
      where: { id: row.id, ownerDecision: "PENDING" },
      data: { ownerDecision: "HANDLED", linkSent: true, decidedAt: new Date(), reason: `${row.reason} (${how})` },
    });
    if (claim.count === 0) continue;
    closed += 1;
    await closeCards(row, `✅ ${whoOf(row.contact)}: уже обработано — ${how}`).catch((err) =>
      logError("receiptAlerts:closeCards", err),
    );
  }
  return closed;
}

/**
 * Фоновая уборка (раз в минуту): чек ждёт решения, но после его прихода человеку
 * заведена и доставлена покупка другим путём (панель «Клиенты», ручная выдача).
 * Закрываем КАЖДЫЙ чек отдельно и консервативно:
 *  • покупка должна быть новее чека и доставлена (ссылка/доступ выданы);
 *  • покупок должно хватать на то, что оплачено (комплект - две), и одна покупка
 *    закрывает только один чек - чек за второй курс не «съедается» чужой выдачей;
 *  • сумма не прочиталась - не трогаем, решает человек.
 * Сообщение Ширин со ссылкой статус НЕ меняет: подпись «Ширин написала» нельзя
 * отличить от обычного ответа со ссылкой на сайт. Закрытый здесь чек
 * подтвердить из интерфейса уже нельзя, поэтому правила узкие.
 */
let lastSweepAt = 0;
const SWEEP_EVERY_MS = 60_000;

export async function closeSettledReceiptAlerts(now = Date.now()): Promise<number> {
  if (now - lastSweepAt < SWEEP_EVERY_MS) return 0;
  lastSweepAt = now;
  const pending = await prisma.receiptCheck.findMany({
    where: { ownerDecision: "PENDING", amount: { not: null } },
    select: { id: true, contactId: true, createdAt: true, amount: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (pending.length === 0) return 0;
  const used = new Set<string>();
  let closed = 0;
  for (const r of pending) {
    // Покупки именно на те курсы, которые даёт сумма ЭТОГО чека; одна покупка
    // закрывает только один чек (чек за 50 не закрывается выдачей курса за 70).
    const courses = await coursesForAmount(r.amount ?? 0);
    if (courses.length === 0) continue;
    const delivered = await deliveredCoursesSince(r.contactId, r.createdAt);
    const keys = courses.map((c) => `${r.contactId}:${c}`);
    if (!courses.every((c) => delivered.includes(c)) || keys.some((k) => used.has(k))) continue;
    for (const k of keys) used.add(k);
    closed += await closeReceiptById(r.id, "доступ уже выдан другим способом");
  }
  return closed;
}

/** Только для тестов: сбросить таймер уборки. */
export function resetSweepClock(): void {
  lastSweepAt = 0;
}
