import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { detectClientLanguage } from "./clientLanguage.js";
import { sendToContact } from "../messaging/send.js";
import { createOneTimeInviteLink } from "../telegram.js";
import { rememberInviteLink } from "../groupAccess.js";
import { chatIdFor, COURSE_TITLE, type Allocation, type Course } from "../courses.js";
import {
  deliveryModeFor,
  issueCourseLink,
  linkPurchaseToCourse,
  accessMessage,
  coursePlatformReady,
} from "../course/delivery.js";
import type { Contact } from "@prisma/client";

/**
 * Выдача доступа к курсам после подтверждения оплаты.
 *
 * Извлечено из ai.ts для снижения сложности god-file. Функция самодостаточна:
 * создаёт Purchase-записи, генерирует one-time ссылки, отправляет их клиенту
 * и откатывает покупку при ошибке отправки (чтобы деньги не были приняты молча).
 */
export async function grantCourses(
  contact: Contact,
  plan: Allocation,
  amount: number,
  verdict: { amount: number | null; currency?: string | null }
): Promise<Course[]> {
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
  const webLinkOnce = async () => (sharedWebLink ??= wantWeb ? await issueCourseLink(contact.id) : null);
  const webOnly = wantWeb && !wantTelegram;
  const pendingWeb: { purchaseId: string; course: Course }[] = [];

  for (const course of plan.grant) {
    let purchaseId: string | null = null;
    try {
      const purchase = await prisma.purchase.create({
        data: {
          contactId: contact.id,
          course,
          amount: Math.round(amount / plan.grant.length),
          rawAmount: verdict.amount,
          currency: verdict.currency ?? "TJS",
        },
      });
      purchaseId = purchase.id;
    } catch {
      continue; // эта группа у человека уже есть — второй ссылки не даём
    }

    // Привязываем покупку к курсу каталога — платформе нужен courseId, чтобы
    // показать уроки. Пока backfill не проходил, тихо пропускается.
    await linkPurchaseToCourse(purchaseId, course);

    const chatId = wantTelegram ? await chatIdFor(course) : null;
    const telegramLink = wantTelegram
      ? botToken && chatId
        ? await createOneTimeInviteLink(botToken, chatId)
        : (await getSetting("courseAccessLink"))?.trim() || null
      : null;
    // Пустой курс (материалы ещё не завезли) не должен уходить как «готово» —
    // если веб-ссылки для него нет, ниже сработает штатное «ссылки нет» и
    // покупка уйдёт на ручную проверку владельцу, а не пропадёт молча.
    const webLink = wantWeb && (await coursePlatformReady(course)) ? await webLinkOnce() : null;
    const link = telegramLink ?? webLink;
    if (!link) {
      await prisma.purchase.delete({ where: { id: purchaseId } }).catch((err) => {
        // P2025 = запись уже удалена (race) — это нормально.
        if ((err as { code?: string })?.code !== "P2025") {
          logError("grantCourses:noLink:deletePurchase", err);
        }
      });
      continue;
    }

    // Только платформа: сообщение ОДНО на все курсы, отправляем после цикла.
    if (webOnly) {
      pendingWeb.push({ purchaseId, course });
      done.push(course);
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
      const mid = await sendToContact(contact, text);
      if (mid) await recordOutgoingMessage(contact.id, text, mid);
      await prisma.purchase.update({ where: { id: purchaseId }, data: { inviteLink: telegramLink ?? link } });
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
      // Отправка не удалась (окно Meta закрылось, пока разбирался чек; 429).
      // Покупку откатываем: иначе человек числится купившим, ссылки у него нет,
      // а владельцу ничего не показывают — деньги приняты молча.
      logError("grantCourses:sendLink", err);
      await prisma.purchase.delete({ where: { id: purchaseId } }).catch((delErr) => {
        // P2025 = запись уже удалена (race) — это нормально.
        if ((delErr as { code?: string })?.code !== "P2025") {
          logError("grantCourses:sendLink:rollbackDelete", delErr);
        }
      });
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
      const mid = await sendToContact(contact, text);
      if (mid) await recordOutgoingMessage(contact.id, text, mid);
      await prisma.purchase.updateMany({
        where: { id: { in: pendingWeb.map((p) => p.purchaseId) } },
        data: { inviteLink: sharedWebLink },
      });
    } catch (err) {
      // Не ушло — откатываем все покупки этой выдачи: деньги не должны быть
      // приняты молча (см. ветку Telegram выше).
      logError("grantCourses:sendLink", err);
      await prisma.purchase
        .deleteMany({ where: { id: { in: pendingWeb.map((p) => p.purchaseId) } } })
        .catch((delErr) => logError("grantCourses:sendLink:rollbackDelete", delErr));
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
}