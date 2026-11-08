import type { Contact } from "@prisma/client";
import { deliveryMode } from "./delivery.js";
import { enqueuePurchaseConversion } from "../metaConversions.js";
import { prisma, logError, recordOutgoingMessage } from "../db.js";
import { contactLanguage } from "../ai/contactLanguage.js";
import { sendToContact } from "../messaging/send.js";
import { isBotFrozen, withVerifiedReceiptDelivery, contactAutomationBlocked } from "../messaging/automation.js";
import { metaFailureKind } from "../messaging/metaErrors.js";
import type { Allocation, Course } from "../courses.js";
import { settleChoiceIfHandedOut } from "./handedOut.js";

export type CourseDeliveryChoice = "telegram" | "web";
export function isDeliveryChoice(value: unknown): value is CourseDeliveryChoice {
  return value === "telegram" || value === "web";
}

export const DELIVERY_QUESTION = {
  ru: "Оплата принята. У вас есть Telegram? Напишите «да», пришлю ссылку в группу с уроками. Напишите «нет», открою уроки на сайте",
  tg: "Пардохт кабул шуд. Telegram доред? «Ха» нависен, ссылкаи группаро мефиристам. «Не» нависен, дарсхоя дар сайт мекушоям",
};

/** Only short explicit answers. An unrelated 'yes' is handled below only when
 * the latest outgoing message is this exact pending delivery question. */
export function parseDeliveryAnswer(text: string): { choice: CourseDeliveryChoice; explicit: boolean } | null {
  const value = text.toLowerCase().trim().replace(/[.!?]+$/u, "").trim();
  if (/^(да|ага|есть|ҳа|ха|бале|дорам|ҳаст|хаст|yes)$/u.test(value)) return { choice: "telegram", explicit: false };
  if (/^(нет|не|надорам|нест|no)$/u.test(value)) return { choice: "web", explicit: false };
  if (/^(?:да[, ]+)?(?:у меня есть |есть )?(?:telegram|телеграм)(?: есть| дорам| ҳаст| хаст)?$/u.test(value)) return { choice: "telegram", explicit: true };
  if (/^(?:(?:у меня нет |нет )(?:telegram|телеграм)|(?:telegram|телеграм)(?: нет| надорам| нест))$/u.test(value) || /^(?:на сайте|сайт|дар сайт|через сайт)$/u.test(value)) return { choice: "web", explicit: true };
  return null;
}

/** Called only from the confirmed-payment grant path. Purchases are durable
 * before asking, so losing the question never loses the paid entitlement. */
export async function deferGrantForChoice(
  contact: Contact, plan: Allocation, amount: number,
  verdict: { amount: number | null; currency?: string | null }, opts: { byHuman?: boolean; purpose?: "verified_receipt_access" },
): Promise<boolean> {
  if (["WEB", "MANUAL", "WHATSAPP"].includes(contact.channel)) return false;
  // Вопрос «куда прислать уроки» нужен только когда владелец выбрал «обе ссылки» (both).
  // В режимах telegram/web человек после оплаты сразу получает одну ссылку, без вопросов
  // (владелец 08.11.2026: «получаем деньги — бот отправляет ссылку на Телеграм, и всё»).
  if ((await deliveryMode()) !== "both") return false;
  const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
  if (!fresh) return false;
  if (isDeliveryChoice(fresh.courseDeliveryChoice)) {
    contact.courseDeliveryChoice = fresh.courseDeliveryChoice;
    return false;
  }
  if (fresh.accessRevokedAt || fresh.spamBlockedAt) return true;
  if (!opts.byHuman && await isBotFrozen()) return true;
  const createdIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < plan.grant.length; i++) {
      const course = plan.grant[i];
      const prior = await tx.purchase.findUnique({ where: { contactId_course: { contactId: contact.id, course } } });
      if (prior?.revokedAt || prior?.inviteLink || prior?.accessDeliveryUncertainAt) continue;
      if (prior) {
        await tx.purchase.update({ where: { id: prior.id }, data: { deliveryAwaitingChoice: true } });
      } else {
        const share = Math.floor(amount / plan.grant.length);
        const catalog = await tx.course.findUnique({ where: { code: course } });
        const created = await tx.purchase.create({ data: {
          contactId: contact.id, course, courseId: catalog?.id ?? null,
          amount: i === plan.grant.length - 1 ? amount - share * i : share,
          rawAmount: verdict.amount, currency: verdict.currency ?? "TJS", deliveryAwaitingChoice: true,
        } });
        if (created?.id) createdIds.push(created.id);
      }
    }
    await tx.contact.updateMany({ where: { id: contact.id, paid: false }, data: { paid: true, paidAt: new Date() } });
  });
  // Оплата подтверждена уже здесь — выбор «куда прислать уроки» её не меняет.
  await enqueuePurchaseConversion(contact.id, createdIds);
  if (await awaitingDeliveryChoice(contact.id)) await askDeliveryChoice(fresh, opts);
  return true;
}

export async function awaitingDeliveryChoice(contactId: string): Promise<boolean> {
  const waiting = (await prisma.purchase.count({ where: { contactId, revokedAt: null, deliveryAwaitingChoice: true } })) > 0;
  if (!waiting) return false;
  // Ширин уже выдала доступ руками - ожидание выбора снимается, бот молчит (08.11.2026).
  return !(await settleChoiceIfHandedOut(contactId));
}

export async function askDeliveryChoice(contact: Contact, opts: { byHuman?: boolean; purpose?: "verified_receipt_access" } = {}): Promise<boolean> {
  if (["WEB", "MANUAL", "WHATSAPP"].includes(contact.channel) || isDeliveryChoice(contact.courseDeliveryChoice)) return false;
  if (!opts.byHuman && await isBotFrozen()) return false;
  if (await settleChoiceIfHandedOut(contact.id)) return false;
  const claim = await prisma.contact.updateMany({
    where: { id: contact.id, courseDeliveryChoice: null, deliveryChoicePromptState: null, accessRevokedAt: null, spamBlockedAt: null },
    data: { deliveryChoicePromptState: "SENDING", deliveryChoiceAskedAt: new Date() },
  });
  if (claim.count !== 1) return false;
  const lastIn = await prisma.message.findFirst({ where: { contactId: contact.id, direction: "IN" }, orderBy: { createdAt: "desc" } });
  const lang = contact.preferredLanguage === "ru" || contact.preferredLanguage === "tg"
    ? contact.preferredLanguage : (await contactLanguage(contact.id, lastIn?.text ?? "")) === "ru" ? "ru" : "tg";
  const text = DELIVERY_QUESTION[lang];
  let sent = false;
  try {
    const mid = await sendToContact(contact, text, [], opts);
    if (!mid) throw new Error("Delivery-choice question acknowledgement missing");
    sent = true;
    await recordOutgoingMessage(contact.id, text, mid);
    await prisma.contact.update({ where: { id: contact.id }, data: { deliveryChoicePromptState: "WAITING", deliveryChoicePromptMid: mid } });
    return true;
  } catch (err) {
    const uncertain = sent || metaFailureKind(err) === "AMBIGUOUS";
    await prisma.contact.update({ where: { id: contact.id }, data: {
      deliveryChoicePromptState: uncertain ? "UNKNOWN" : "FAILED",
      ...(!uncertain ? { deliveryChoiceAskedAt: null } : {}),
    } });
    logError("deliveryChoice:question", err);
    return false;
  }
}

/** Deterministic entry before the model and access recovery. No fresh payment,
 * no question state, or an unrelated answer => never chooses a delivery mode. */
export async function handleDeliveryChoiceReply(contact: Contact, text: string): Promise<boolean> {
  const receipt = await prisma.receiptCheck.findFirst({ where: {
    contactId: contact.id, awaitingDeliveryChoice: true,
    OR: [{ ownerDecision: "APPROVED" }, { ownerDecision: null, kind: "valid" }],
  }, select: { imageHash: true } });
  return receipt?.imageHash
    ? withVerifiedReceiptDelivery(contact.id, receipt.imageHash, () => handleChoice(contact, text, true))
    : handleChoice(contact, text, false);
}

async function handleChoice(contact: Contact, text: string, verifiedReceipt: boolean): Promise<boolean> {
  if (await isBotFrozen()) return false;
  const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
  if (!fresh || fresh.accessRevokedAt || contactAutomationBlocked(fresh, verifiedReceipt ? "verified_receipt_access" : "reply") || !await awaitingDeliveryChoice(contact.id)) return false;
  if ((!fresh.deliveryChoicePromptState || fresh.deliveryChoicePromptState === "FAILED") && !isDeliveryChoice(fresh.courseDeliveryChoice)) {
    if (fresh.deliveryChoicePromptState === "FAILED") await prisma.contact.updateMany({ where: { id: contact.id, deliveryChoicePromptState: "FAILED" }, data: { deliveryChoicePromptState: null } });
    await askDeliveryChoice(fresh, verifiedReceipt ? { purpose: "verified_receipt_access" } : {});
    return true;
  }
  const answer = parseDeliveryAnswer(text);
  if (!answer) return false;
  if (!answer.explicit) {
    const latest = await prisma.message.findFirst({ where: { contactId: contact.id, direction: "OUT" }, orderBy: { createdAt: "desc" } });
    const isQuestion = latest?.mid === fresh.deliveryChoicePromptMid && Boolean(fresh.deliveryChoicePromptMid);
    // UNKNOWN may have reached the user even though its acknowledgement was lost.
    // Bare yes/no is unsafe then: only an explicit Telegram/site answer is accepted.
    if (!isQuestion) return false;
  }
  if (isDeliveryChoice(fresh.courseDeliveryChoice) && fresh.courseDeliveryChoice !== answer.choice) return false;
  const chosen = await prisma.contact.updateMany({
    where: { id: contact.id, accessRevokedAt: null, spamBlockedAt: null,
      OR: [{ courseDeliveryChoice: null }, { courseDeliveryChoice: answer.choice }], deliveryChoiceDispatchAt: null },
    data: { courseDeliveryChoice: answer.choice, deliveryChoiceDispatchAt: new Date() },
  });
  if (chosen.count !== 1) return true;
  let dispatchFailed = false;
  try {
    const pending = await prisma.purchase.findMany({ where: {
      contactId: contact.id, revokedAt: null, deliveryAwaitingChoice: true, accessDeliveryUncertainAt: null,
    } });
    const grant = pending.map((p) => p.course).filter((c): c is Course => c === "COURSE50" || c === "COURSE70");
    if (grant.length > 0 && !await isBotFrozen()) {
      const { grantCourses } = await import("../ai/grantCourses.js");
      await grantCourses({ ...fresh, courseDeliveryChoice: answer.choice }, { grant, note: "выбран способ обучения" },
        pending.reduce((sum, p) => sum + p.amount, 0), { amount: null, currency: "TJS" }, { fromDeliveryChoice: true });
    }
    if (!await awaitingDeliveryChoice(contact.id)) {
      await prisma.receiptCheck.updateMany({ where: { contactId: contact.id, awaitingDeliveryChoice: true },
        data: { linkSent: true, awaitingDeliveryChoice: false } });
    }
  } catch (err) {
    dispatchFailed = true;
    logError("deliveryChoice:dispatch", err);
    // A process/network uncertainty must be investigated, not blindly replayed.
    throw err;
  } finally {
    if (!dispatchFailed) await prisma.contact.update({ where: { id: contact.id }, data: { deliveryChoiceDispatchAt: null } });
  }
  return true;
}
