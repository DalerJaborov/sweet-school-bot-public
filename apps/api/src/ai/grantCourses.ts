import { deferGrantForChoice } from "../course/deliveryChoice.js";
import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { detectClientLanguage } from "./clientLanguage.js";
import { sendToContact } from "../messaging/send.js";
import { createOneTimeInviteLink } from "../telegram.js";
import { rememberInviteLink } from "../groupAccess.js";
import { chatIdFor, COURSE_TITLE, splitAmount, type Allocation, type Course } from "../courses.js";
import {
  deliveryModeFor,
  issueCourseLink,
  linkPurchaseToCourse,
  accessMessage,
  coursePlatformReady,
} from "../course/delivery.js";
import type { Contact } from "@prisma/client";
import { metaFailureKind } from "../messaging/metaErrors.js";
import { isBotFrozen, currentReceiptEvidence, assertContactMessagingAllowed } from "../messaging/automation.js";
import { enqueuePurchaseConversion } from "../metaConversions.js";

/**
 * Выдача доступа к курсам после подтверждения оплаты.
 *
 * Извлечено из ai.ts для снижения сложности god-file. Функция самодостаточна:
 * создаёт Purchase-записи, генерирует one-time ссылки, отправляет их клиенту
 * и сохраняет оплату при ошибке отправки для повторной доставки.
 */
export async function grantCourses(
  contact: Contact,
  plan: Allocation,
  amount: number,
  verdict: { amount: number | null; currency?: string | null },
  opts: { byHuman?: boolean; fromDeliveryChoice?: boolean } = {}
): Promise<Course[]> {
  if (!opts.byHuman && (await isBotFrozen())) return [];
  const sendOpts = { ...opts, ...(currentReceiptEvidence()?.contactId === contact.id ? { purpose: "verified_receipt_access" as const } : {}) };
  await assertContactMessagingAllowed(contact.id, opts.byHuman ? "human" : sendOpts.purpose ?? "reply");
  if (!opts.fromDeliveryChoice && await deferGrantForChoice(contact, plan, amount, verdict, sendOpts)) return [];
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const done: Course[] = [];

  // Куда ведём человека: привычная Telegram-группа, своя платформа или обе
  // сразу (см. course/delivery.ts). По умолчанию — как было, только группа:
  // новая дверь не должна открыться сюрпризом после деплоя. Пришедшей с сайта
  // — всегда платформа (deliveryModeFor): Telegram у неё может не быть.
  const mode = await deliveryModeFor(contact);
  const wantTelegram = mode === "telegram" || mode === "both";
  const wantWeb = mode === "web" || mode === "both";

  // ССЫЛКА НА ПЛАТФОРМУ — ОДНА НА ЧЕЛОВЕКА, а не на курс: купила оба — одно
  // окно с обоими. Выпускаем один раз и не в цикле. «Докупила» — если до этой
  // выдачи у неё уже были действующие курсы: тогда текст другой.
  const hadBefore = wantWeb
    ? await prisma.purchase.count({ where: { contactId: contact.id, revokedAt: null } })
    : 0;
  // Выпускаем ЛЕНИВО — при первой реально созданной покупке. Выпуск до цикла
  // ротировал бы ссылку даже когда все create упали по уникальности (повторный
  // чек на уже купленный курс): сообщение не уходило, а прежняя, ещё не
  // открытая ссылка ученицы уже была мертва (ревью 03.09.2026).
  let sharedWebLink: string | null = null;
  const webLinkOnce = async () => {
    if (!opts.byHuman && (await isBotFrozen())) return null;
    return (sharedWebLink ??= wantWeb ? await issueCourseLink(contact.id, { automatic: !opts.byHuman, preserveExisting: true }) : null);
  };
  const webOnly = wantWeb && !wantTelegram;
  const pendingWeb: { purchaseId: string; course: Course }[] = [];
  const createdIds: string[] = [];
  // Оплата — в рекламу Meta (metaConversions.ts): в finally, чтобы любой выход
  // из выдачи — успех, сбой отправки ссылки, исключение — не потерял оплату.
  // Откаченные при заморозке покупки enqueue отсеет сам (их уже нет в базе).
  try {
  const deliveryFailed = async (error: unknown, ids: string[]) => {
    if (!opts.byHuman && (await isBotFrozen())) {
      await prisma.purchase.deleteMany({ where: { id: { in: ids.filter((id) => createdIds.includes(id)) } } });
      return;
    }
    if (metaFailureKind(error) === "AMBIGUOUS") {
      await prisma.purchase.updateMany({ where: { id: { in: ids } }, data: { accessDeliveryUncertainAt: new Date() } });
    }
    logError("grantCourses:deliveryPending", error);
    await prisma.contact.updateMany({ where: { id: contact.id, paid: false }, data: { paid: true, paidAt: new Date() } });
  };
  const stopIfFrozen = async (): Promise<boolean> => {
    if (opts.byHuman || !(await isBotFrozen())) return false;
    if (pendingWeb.length > 0) {
      await prisma.purchase.deleteMany({ where: { id: { in: pendingWeb.map((p) => p.purchaseId).filter((id) => createdIds.includes(id)) } } });
    }
    return true;
  };

  // Сумма делится только между НОВЫМИ курсами: повтор доставки уже созданной
  // покупки не должен уменьшать долю (35 вместо 70).
  const already = await prisma.purchase.findMany({ where: { contactId: contact.id, course: { in: plan.grant } }, select: { course: true } });
  const newList = plan.grant.filter((c) => !(already ?? []).some((a) => a.course === c));
  const shares = splitAmount(amount, newList.length);
  for (const course of plan.grant) {
    if (await stopIfFrozen()) return done;
    let purchaseId: string | null = null;
    const existing = await prisma.purchase.findUnique({ where: { contactId_course: { contactId: contact.id, course } } });
    if (existing) {
      // Resume only an undelivered active purchase; never revive revoked access.
      if (existing.revokedAt || existing.inviteLink || existing.accessDeliveryUncertainAt ||
          (existing.deliveryAwaitingChoice && !opts.fromDeliveryChoice)) continue;
      purchaseId = existing.id;
    } else {
      try {
        const purchase = await prisma.purchase.create({ data: {
          contactId: contact.id, course, amount: shares[Math.max(0, newList.indexOf(course))] ?? Math.round(amount),
          rawAmount: verdict.amount, currency: verdict.currency ?? "TJS",
        } });
        purchaseId = purchase.id;
        createdIds.push(purchase.id);
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        continue;
      }
    }

    // Привязываем покупку к курсу каталога — платформе нужен courseId, чтобы
    // показать уроки. Пока backfill не проходил, тихо пропускается.
    await linkPurchaseToCourse(purchaseId, course);

    // Only roll back a new purchase from this invocation; preserve paid access.
    if (!opts.byHuman && (await isBotFrozen())) {
      if (createdIds.includes(purchaseId)) await prisma.purchase.delete({ where: { id: purchaseId } });
      await stopIfFrozen();
      return done;
    }

    const chatId = wantTelegram ? await chatIdFor(course) : null;
    if (!opts.byHuman && (await isBotFrozen())) {
      if (createdIds.includes(purchaseId)) await prisma.purchase.delete({ where: { id: purchaseId } });
      await stopIfFrozen();
      return done;
    }
    let telegramLink: string | null;
    let webLink: string | null;
    try {
      telegramLink = wantTelegram
        ? botToken && chatId
          ? await createOneTimeInviteLink(botToken, chatId)
          : contact.courseDeliveryChoice === "telegram" ? null : (await getSetting("courseAccessLink"))?.trim() || null
        : null;
    // Пустой курс (материалы ещё не завезли) не должен уходить как «готово» —
    // если веб-ссылки для него нет, ниже сработает штатное «ссылки нет» и
    // покупка уйдёт на ручную проверку владельцу, а не пропадёт молча.
      webLink = wantWeb && (await coursePlatformReady(course)) ? await webLinkOnce() : null;
    } catch (err) {
      // A late freeze can reject token issuance. It must not leave a newly
      // granted purchase behind, or delete any pre-existing paid course.
      if (!opts.byHuman && (await isBotFrozen())) {
        if (createdIds.includes(purchaseId)) await prisma.purchase.delete({ where: { id: purchaseId } });
        await stopIfFrozen();
        return done;
      }
      await deliveryFailed(err, [purchaseId]);
      continue;
    }
    const link = telegramLink ?? webLink;
    if (!link) {
      await deliveryFailed(new Error(`No delivery link for purchase ${purchaseId}`), [purchaseId]);
      continue;
    }

    // Только платформа: сообщение ОДНО на все курсы, отправляем после цикла.
    if (webOnly) {
      pendingWeb.push({ purchaseId, course });
      continue;
    }

    try {
      const text =
        accessMessage({
          courseTitle: COURSE_TITLE[course],
          telegramLink,
          webLink,
          withTitle: plan.grant.length > 1,
        }) ?? link;
      const mid = await sendToContact(contact, text, [], sendOpts);
      if (!mid) throw new Error("Access message delivery not confirmed");
      await recordOutgoingMessage(contact.id, text, mid);
      await prisma.purchase.update({ where: { id: purchaseId }, data: { inviteLink: telegramLink ?? link, deliveryAwaitingChoice: false } });
      // Связь «ссылка → человек» нужна, чтобы узнать его в Telegram при входе.
      // Веб-ссылку сюда класть нельзя: по ней в группу никто не входит, и
      // handleChatMember искал бы по ней вошедшего впустую.
      if (telegramLink) {
        await rememberInviteLink(contact.id, telegramLink).catch((err) => {
          logError("grantCourses:rememberInviteLink", err);
        });
      }
      done.push(course);
    } catch (err) {
      // Payment remains recorded; inviteLink stays null for a safe delivery retry.
      await deliveryFailed(err, [purchaseId]);
    }
  }

  if (webOnly && pendingWeb.length > 0 && sharedWebLink) {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const language = detectClientLanguage(lastIn?.text ?? "");
    const titles = pendingWeb.map((p) => COURSE_TITLE[p.course]).join(", ");
    const text =
      accessMessage({
        courseTitle: titles,
        telegramLink: null,
        webLink: sharedWebLink,
        withTitle: true,
        language,
        added: hadBefore > 0,
      }) ?? sharedWebLink;
    try {
      const mid = await sendToContact(contact, text, [], sendOpts);
      if (!mid) throw new Error("Access message delivery not confirmed");
      await recordOutgoingMessage(contact.id, text, mid);
      await prisma.purchase.updateMany({
        where: { id: { in: pendingWeb.map((p) => p.purchaseId) } },
        data: { inviteLink: sharedWebLink, deliveryAwaitingChoice: false },
      });
      done.push(...pendingWeb.map((p) => p.course));
    } catch (err) {
      await deliveryFailed(err, pendingWeb.map((p) => p.purchaseId));
      return [];
    }
  }

  if (done.length > 0) {
    await prisma.contact
      .updateMany({ where: { id: contact.id, paid: false }, data: { paid: true, paidAt: new Date() } })
      .catch((err) => {
        logError("grantCourses:markPaid", err);
      });
  }
  return done;
  } finally {
    if (createdIds.length > 0) await enqueuePurchaseConversion(contact.id, createdIds);
  }
}
