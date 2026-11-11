import { awaitingDeliveryChoice, askDeliveryChoice } from "../course/deliveryChoice.js";
import { Prisma } from "@prisma/client";
import type { Contact } from "@prisma/client";
import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { isBotFrozen, withVerifiedReceiptDelivery, contactAutomationBlocked } from "../messaging/automation.js";
import { enqueuePurchaseConversion } from "../metaConversions.js";
import { sendReceiptForReview, sendTelegramMessage, summaryChatIds } from "../telegram.js";
import { grantCourses } from "./grantCourses.js";
import { markExamplesAsSuccessful } from "./styleLearning.js";
import { allocate, COURSE_TITLE, coursesForAmount, ownedCourses, planForAmount, type Course } from "../courses.js";
import { toSomoni } from "../exchangeRates.js";
import { type ClientLanguage } from "./clientLanguage.js";
import { contactLanguage } from "./contactLanguage.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { paymentLine } from "./prompts.js";
import { rememberAlert } from "../receiptAlerts.js";
import { ACCEPTED_WHERE, receiptAccepted } from "../receiptAccepted.js";
import { manualLinkServesCourse, manualLinksSince, manualLinkSince, receiptServedState } from "../course/handedOut.js";
import { notifyOwnerDirect } from "../systemAlerts.js";

const RECEIPT_CONFIDENCE_THRESHOLD = 50;

export { receiptAccepted };

/** Просим прислать другой скриншот чека (другой ракурс/из истории банка) —
 *  решение владельца 25.08.2026 веч.: сначала дать клиенту шанс самому
 *  разобраться, а не сразу звать владельца на каждый нечёткий чек. */
const ALT_SCREENSHOT_TEXT: Record<ClientLanguage, string> = {
  ru: "Чек плохо читается. Пришлите ещё один скрин, можно из истории банка",
  tg: "Чек хуб маълум нест. Боз як скриншот фиристен, аз истории банк хам мешавад",
  en: "The receipt isn't readable. Could you send another screenshot? One from your bank history works too",
};

/**
 * ЭКРАН ДО ПЕРЕВОДА (05.09.2026). Клиентка ввела наш номер в банке, увидела имя
 * получателя и прислала скриншот: «правильно?». Раньше это шло как «нечёткий
 * чек» с просьбой прислать ещё — человек пугался. Теперь отвечаем по делу:
 * да, номер и имя верные, переводите и присылайте чек. Реквизиты — из той же
 * таблицы «Тексты и цены», что у бота.
 */
export async function confirmRequisitesToCustomer(contact: Contact, lastText: string | null): Promise<void> {
  // Второй скриншот ТОГО ЖЕ перевода (экран проверки получателя после оплаты):
  // человек только что заплатил и получил ссылку - "переводите и пришлите чек"
  // его запутало бы. Отвечаем, что перевод уже принят.
  const justPaid = await prisma.receiptCheck.findFirst({
    where: { contactId: contact.id, OR: ACCEPTED_WHERE, createdAt: { gte: new Date(Date.now() - 2 * SAME_TRANSFER_WINDOW_MS) } },
    select: { id: true },
  });
  if (justPaid) {
    await tellAlreadyAccepted(contact, lastText);
    return;
  }
  const texts = await getSalesTexts();
  const line = paymentLine(texts);
  const byLang: Record<ClientLanguage, string> = {
    ru: `Да, всё верно, это наш номер: ${line}. Переводите и пришлите сюда чек, открою уроки`,
    tg: `Ха, дуруст, раками мо: ${line}. Пулро гузаронен, чекро хамин чо фиристен, дарсхоя мекушоям`,
    en: `Yes, that's correct, it's our number: ${line}. Send the transfer and the receipt here, and I'll open the lessons`,
  };
  const lastIn = lastText?.trim()
    ? { text: lastText }
    : await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "IN", text: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { text: true },
      });
  const text = byLang[await contactLanguage(contact.id, lastIn?.text ?? "")];
  const mid = await sendToContact(contact, text);
  if (mid) await recordOutgoingMessage(contact.id, text, mid);
}

/** Тот же перевод прислан второй раз (та же сумма за последние двое суток уже
 *  открыла доступ). Раньше 70 сомони дважды открывали ВТОРОЙ курс как новую покупку. */
const DUPLICATE_WINDOW_MS = 48 * 3_600_000;
const DUPLICATE_PAYMENT_TEXT: Record<ClientLanguage, string> = {
  ru: "Этот перевод уже приняли, ссылка на уроки выше в этом чате. Если это другая оплата, напишите",
  tg: "Ин пулро гирифтем, ссылкаи дарсхо болотар хаст. Агар дигар пардохт бошад, нависен",
  en: "We've already accepted this transfer, the lesson link is above in this chat. If it's a different payment, let us know",
};

/**
 * ЧЕК УШЁЛ ВЛАДЕЛЬЦУ — КЛИЕНТКА ОБ ЭТОМ ЗНАЕТ (05.09.2026).
 *
 * Раньше после эскалации клиентке не уходило ни слова: чек в 2 часа ночи —
 * и тишина до утра, пока Ширин не откроет Telegram. Человек, только что
 * заплативший незнакомке, в этой тишине решает, что его обманули.
 *
 * Обещание честное: «обычно в течение часа, ночью — утром», без точного срока,
 * которого мы не контролируем. Уходит РОВНО ОДИН РАЗ на чек — отметка
 * customerNotifiedAt в строке ReceiptCheck, потому что тот же чек проходит
 * разбор и сразу, и из очереди перепроверки.
 */
const FORWARDED_TO_OWNER_TEXT: Record<ClientLanguage, string> = {
  ru: "Чек получила, передаю Ширин на проверку. Ссылка на уроки придёт сюда, обычно в течение часа, а ночью утром",
  tg: "Чекро гирифтам, ба Ширин барои тафтиш медихам. Ссылкаи дарсхо хамин чо меояд, одатан дар як соат, шаб бошад пагох",
  en: "Got your receipt, passing it to Shirin to check. The lesson link will arrive right here, usually within an hour, overnight in the morning",
};

export async function notifyCustomerReceiptForwarded(contact: Contact, receipt: { id: string }): Promise<void> {
  if (await isBotFrozen()) return;
  // Отметка ДО отправки и атомарно (условие в самом UPDATE): два разбора того
  // же чека почти одновременно — второй получит count=0 и промолчит. Лучше не
  // прислать сообщение вовсе, чем прислать дважды.
  const claimed = await prisma.receiptCheck.updateMany({
    where: { id: receipt.id, customerNotifiedAt: null },
    data: { customerNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const lastIn = await prisma.message.findFirst({
    where: { contactId: contact.id, direction: "IN", text: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { text: true },
  });
  const text = FORWARDED_TO_OWNER_TEXT[await contactLanguage(contact.id, lastIn?.text ?? "")];
  if (await isBotFrozen()) return;
  await sendToContact(contact, text)
    .then((mid) => {
      if (mid) return recordOutgoingMessage(contact.id, text, mid);
    })
    .catch((err) => logError("receiptVerdict:notifyCustomerForwarded", err));
}

/** Давнишний чек: старше этого — скорее чужой старый скриншот, стоит показать
 *  человеку глазами. НЕРАСПОЗНАННАЯ дата сама по себе поводом больше не служит
 *  (08.11.2026): на настоящих чеках Душанбе Сити время часто не читается. */
const RECEIPT_STALE_HOURS = 72;
/** Дата «из будущего» дальше этого — похоже на подделку; меньше — часовой пояс. */
const RECEIPT_FUTURE_HOURS = 12;
/** С какого расхождения дату стоит УПОМЯНУТЬ в карточке (не блокируя). */
const RECEIPT_ODD_DATE_HOURS = 12;
/** Два скриншота одного перевода (подтверждение + экран проверки получателя)
 *  приходят подряд; чек, пришедший в этом окне после уже принятого, — не новый. */
export const SAME_TRANSFER_WINDOW_MS = 15 * 60_000;
/** Одна сумма на двух экранах может отличаться (списано 650 ₽ ≈ 73, зачислено 71.45). */
const SAME_TRANSFER_AMOUNT_GAP = 5;

/** Тот же скриншот уже лежит у ДРУГОГО человека: строку не создать (отпечаток
 *  уникален), но молча отбрасывать нельзя - владельцу и сестре уходит текст
 *  (без кнопок: решать по чужой строке нельзя). */
async function notifyOwnerText(contact: Contact, text: string): Promise<void> {
  try {
    const botToken = (await getSetting("telegramBotToken"))?.trim();
    if (!botToken) return;
    const who = contact.username ? `@${contact.username}` : contact.igUserId;
    for (const chatId of await summaryChatIds()) await sendTelegramMessage(botToken, chatId, `${who}: ${text}`);
  } catch (err) {
    logError("receiptVerdict:ownerText", err);
  }
}

async function notifyHashTaken(contact: Contact, otherContactId: string, amount: number | null, imageUrl: string | null): Promise<void> {
  try {
    const botToken = (await getSetting("telegramBotToken"))?.trim();
    if (!botToken) return;
    const other = await prisma.contact.findUnique({ where: { id: otherContactId }, select: { username: true, igUserId: true } });
    const name = (c: { username: string | null; igUserId: string } | null) => (c ? (c.username ? `@${c.username}` : c.igUserId) : "?");
    const text =
      `Чек требует проверки: этот же скриншот уже присылал другой человек (${name(other)}).\n` +
      `Сейчас прислал: ${name(contact)}\nСумма: ${amount != null ? `${Math.round(amount * 100) / 100} сомони` : "не разобрана"}\n` +
      `Доступ не выдан.${imageUrl ? `\nКартинка: ${imageUrl}` : ""}`;
    for (const chatId of await summaryChatIds()) await sendTelegramMessage(botToken, chatId, text);
  } catch (err) {
    logError("receiptVerdict:hashTaken", err);
  }
}

async function tellAlreadyAccepted(contact: Contact, lastText: string | null = null): Promise<boolean> {
  // Ссылки ещё нет (ждём ответа про Telegram) - не обещаем "ссылка выше", а
  // спрашиваем снова.
  if (await awaitingDeliveryChoice(contact.id)) {
    return askDeliveryChoice(contact);
  }
  const lastIn = lastText?.trim()
    ? { text: lastText }
    : await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "IN", text: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { text: true },
      });
  const text = DUPLICATE_PAYMENT_TEXT[await contactLanguage(contact.id, lastIn?.text ?? "")];
  if (await isBotFrozen()) return false;
  let sent = false;
  await sendToContact(contact, text)
    .then((mid) => {
      if (mid) sent = true;
      return mid ? recordOutgoingMessage(contact.id, text, mid) : undefined;
    })
    .catch((err) => logError("receiptVerdict:alreadyAccepted", err));
  return sent;
}

/** Курсы уже реально доставлены человеку (ссылка выдана) — например, соседним
 *  разбором второго скриншота того же перевода. */
async function coursesAlreadyDelivered(contactId: string, courses: Course[]): Promise<boolean> {
  const n = await prisma.purchase.count({
    where: {
      contactId,
      course: { in: courses },
      revokedAt: null,
      accessDeliveryUncertainAt: null,
      OR: [{ inviteLink: { not: null } }, { accessIssuedAt: { not: null } }],
    },
  });
  return n >= courses.length;
}

/** Карточка владельцу в Telegram — с фото и кнопками «Подтвердить»/«Отклонить».
 *  Только при реальном сомнении; текст короткий: сумма, что смущает, что видит ИИ.
 *  Если Telegram не настроен, чек остаётся во вкладке «Чеки»: тихо потерять нельзя. */
async function askOwner(
  contact: Contact,
  receiptId: string,
  verdict: { amount: number | null; receiptAt: Date | null; imageUrl: string | null },
  doubts: string[],
  modelReason: string,
  willOpen: string | null = null,
  closeAsDuplicate = false
): Promise<void> {
  if (await isBotFrozen()) return;
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken || !verdict.imageUrl) return;

  // Карточки сомнительных чеков — владельцу и сестре (telegramSummaryChatIds).
  const recipients = await summaryChatIds();
  if (recipients.length === 0) return;

  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const caption =
    `Чек требует проверки\nОт: ${who}\n` +
    `Сумма: ${verdict.amount != null ? `${Math.round(verdict.amount * 100) / 100} сомони` : "не разобрана"}\n` +
    (verdict.receiptAt ? `Дата на чеке: ${verdict.receiptAt.toLocaleString("ru-RU")}\n` : "") +
    `Что смущает: ${doubts.length > 0 ? doubts.join("; ") : "требуется взгляд человека"}\n` +
    (willOpen != null ? `Подтвердить откроет: ${willOpen}\n` : "") +
    (modelReason ? `\nНа чеке: ${modelReason.slice(0, 200)}` : "");

  const needsCourseChoice = verdict.amount == null;
  for (const chatId of recipients) {
    if (await isBotFrozen()) return;
    const sent = await sendReceiptForReview(botToken, chatId, { imageUrl: verdict.imageUrl, caption, receiptId, needsCourseChoice, closeAsDuplicate });
    if (sent) await rememberAlert(receiptId, sent);
  }
}

/**
 * Ширин выдала ссылку руками, а чек настоящий: записываем покупку и оплату без
 * второй ссылки и без карточки владельцу (владелец 11.11.2026).
 *
 * ДЕНЬГИ — СВЕРКА ССЫЛКИ (ревью 11.11.2026). Раньше в покупку писалась любая
 * последняя ссылка Ширин за всё время (since = 0), а без ссылки — строка
 * «выдано вручную»: оплата закрывалась молча, даже если ссылка вела в другую
 * группу или была общей, а вход по общей ссылке потом привязывался к этому
 * человеку. Теперь:
 *  - ссылки берутся только присланные ПОСЛЕ чека (since = момент чека);
 *  - каждая сверяется с курсом (course/handedOut.ts::manualLinkServesCourse);
 *  - совпала — покупка помнит ссылку, закрываем молча;
 *  - не совпала или ссылка неизвестна — оплату всё равно отмечаем (деньги пришли),
 *    но ссылку в покупку НЕ пишем и Далеру уходит одна строка «сверьте группу».
 */
async function settleManualHandout(
  contact: Contact,
  courses: Course[],
  amount: number,
  verdict: { amount: number | null; currency?: string | null; confidence: number; imageHash: string; imageUrl: string | null; receiptAt: Date | null; transactionId?: string | null },
  receiptId: string,
  reason: string,
  receiptAt: Date,
): Promise<void> {
  const links = await manualLinksSince(contact.id, receiptAt).catch((err) => {
    logError("receiptVerdict:manualLinks", err);
    return [] as string[];
  });
  const linkFor = new Map<Course, string>();
  for (const course of courses) {
    for (const link of links) {
      const ok = await manualLinkServesCourse(contact.id, link, course).catch((err) => {
        logError("receiptVerdict:manualLinkCheck", err);
        return false;
      });
      if (ok) {
        linkFor.set(course, link);
        break;
      }
    }
  }
  const created: string[] = [];
  for (const course of courses) {
    try {
      const row = await prisma.purchase.create({
        data: {
          contactId: contact.id, course, amount: Math.round(amount / courses.length),
          rawAmount: verdict.amount, currency: verdict.currency ?? "TJS", inviteLink: linkFor.get(course) ?? null,
        },
      });
      if (row?.id) created.push(row.id);
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") logError("receiptVerdict:manualHandout", err);
    }
  }
  const unverified = courses.filter((c) => !linkFor.has(c));
  await prisma.contact.updateMany({ where: { id: contact.id, paid: false }, data: { paid: true, paidAt: new Date() } });
  await prisma.receiptCheck.update({
    where: { id: receiptId },
    data: {
      kind: "valid",
      confidence: verdict.confidence,
      amount: Math.round(amount),
      receiptAt: verdict.receiptAt,
      transactionId: verdict.transactionId?.trim() && verdict.transactionId.trim().length >= 6 ? verdict.transactionId.trim() : null,
      linkSent: true,
      ownerDecision: "HANDLED",
      decidedAt: new Date(),
      reason:
        `${reason} (ссылку отправила Ширин сама, оплата отмечена автоматически` +
        (unverified.length > 0 ? `; группа не сверена: ${unverified.map((c) => COURSE_TITLE[c]).join(", ")})` : ", группа сверена)"),
    },
  });
  if (created.length > 0) await enqueuePurchaseConversion(contact.id, created);
  if (unverified.length > 0) {
    // Тех-чат Далера (systemAlerts.ts::notifyOwnerDirect), не Ширин: она эту ссылку и выдала.
    const who = contact.username ? `@${contact.username}` : contact.igUserId;
    await notifyOwnerDirect(
      `${who}: оплата ${Math.round(amount)} сомони (${unverified.map((c) => COURSE_TITLE[c]).join(", ")}) отмечена, ` +
        "ссылку дала Ширин сама — сверьте группу.",
    ).catch((err) => logError("receiptVerdict:manualHandoutNotify", err));
  }
}

export async function handleReceiptVerdict(
  contact: Contact,
  verdict: {
    kind: "valid" | "suspicious";
    confidence: number;
    amount: number | null;
    receiptAt: Date | null;
    reason: string;
    currency?: string | null;
    tamperingSuspected?: boolean;
    recipientMatches?: boolean;
    imageHash: string;
    imageUrl: string | null;
    transactionId?: string | null;
  },
  existingId?: string
): Promise<void> {
  if (await isBotFrozen()) return;
  // ОТЛОЖЕННАЯ ПЕРЕПРОВЕРКА ПОСЛЕ РУЧНОЙ ВЫДАЧИ (08.11.2026): чек ждал в очереди,
  // а нужные курсы человеку уже выданы - молчим и закрываем. Если Ширин лишь
  // прислала ссылку вне системы (покупок нет) - оплату молча не закрываем:
  // карточка владельцу с пометкой, клиентке ничего не пишем.
  let maybeServed = false;
  // Момент чека: ссылки Ширин считаются только присланные после него (settleManualHandout).
  let queuedAt: Date | null = null;
  if (existingId) {
    const queued = await prisma.receiptCheck.findUnique({ where: { id: existingId }, select: { createdAt: true } });
    queuedAt = queued?.createdAt ?? null;
    if (queued) {
      const tjs = verdict.amount != null && (verdict.currency ?? "TJS").toUpperCase() === "TJS";
      // Другой чек этого человека уже открыл доступ после этого: покупки могли
      // появиться от него, а не от ручной выдачи - решают обычные проверки
      // повтора и второго платежа ниже, молча не закрываем.
      const explainedByOtherReceipt =
        (await prisma.receiptCheck.count({
          where: {
            contactId: contact.id,
            id: { not: existingId },
            createdAt: { gte: queued.createdAt },
            OR: ACCEPTED_WHERE,
          },
        })) > 0;
      if (tjs && !explainedByOtherReceipt) {
        const state = await receiptServedState(contact.id, queued.createdAt, await coursesForAmount(verdict.amount as number));
        if (state === "served") {
          await prisma.receiptCheck.update({
            where: { id: existingId },
            data: {
              kind: "valid",
              linkSent: true,
              confidence: verdict.confidence,
              reason: `${verdict.reason} (доступ на эти курсы уже выдан - автоматика не сработала)`,
              amount: Math.round(verdict.amount as number),
              ownerDecision: "HANDLED",
              decidedAt: new Date(),
            },
          });
          return;
        }
        maybeServed = state === "maybe";
      } else if (!tjs) {
        // Сумма не в сомони или не прочитана: курсы не определить - если Ширин
        // уже прислала ссылку, клиентке не пишем, чек идёт владельцу.
        maybeServed = await manualLinkSince(contact.id, queued.createdAt);
      }
    }
  }
  const previous = await prisma.receiptCheck.findUnique({ where: { imageHash: verdict.imageHash } });
  if (previous?.contactId === contact.id && previous.awaitingDeliveryChoice) {
    await askDeliveryChoice(contact);
    return;
  }
  // ТОТ ЖЕ СКРИНШОТ ПРИСЛАН ВТОРОЙ РАЗ ТЕМ ЖЕ ЧЕЛОВЕКОМ (двойной тап, «где ссылка?»).
  // Раньше он перезаписывал уже закрытую строку и звал владельца заново. Теперь
  // строку не трогаем: принятый — «уже приняли», ждущий владельца — молчим
  // (человек уже знает, что чек у Ширин), отклонённый — решение владельца в силе.
  if (!existingId && previous && previous.contactId === contact.id && previous.kind !== "unchecked") {
    if (receiptAccepted(previous) || (previous.kind === "duplicate" && /доступ уже открыт/.test(previous.reason))) {
      await tellAlreadyAccepted(contact);
      return;
    }
    if ((previous.ownerDecision === "PENDING" && previous.ownerAlerts) || previous.ownerDecision === "REJECTED") return;
  }
  let kind: string = verdict.kind;
  let reason = verdict.reason;
  // Что смущает — по-человечески, для карточки владельцу. «hard» — жёсткие
  // стопы защиты от обмана: по ним клиентку не просим «пришлите ещё».
  const doubts: string[] = [];
  let hard = false;
  let conversionFailed = false;

  // ЧЕК ИЗ-ЗА ГРАНИЦЫ. Переводим по текущему курсу и дальше работаем уже с сомони.
  let amount = verdict.amount;
  const currency = (verdict.currency ?? "TJS").toUpperCase();
  if (amount != null && currency !== "TJS") {
    const converted = await toSomoni(amount, currency);
    if (converted == null) {
      kind = "suspicious";
      conversionFailed = true;
      reason = `${reason} (чек в ${currency}, курс сейчас недоступен — проверьте сумму сами)`;
      doubts.push(`чек в ${currency}, курс сейчас недоступен`);
      amount = null;
    } else {
      reason = `${reason} (${verdict.amount} ${currency} ≈ ${Math.round(converted)} сомони по курсу)`;
      amount = converted;
    }
  }

  // ЧЁРНЫЙ СПИСОК.
  const blocked = await prisma.blockedReceipt.findUnique({ where: { imageHash: verdict.imageHash } });
  if (blocked) {
    kind = "suspicious";
    hard = true;
    reason = `В чёрном списке: ${blocked.reason}`;
    doubts.push("чек из чёрного списка");
  }

  // Тот же скриншот уже открывал доступ (другому человеку — свой повтор отсеян выше).
  const reused = await prisma.receiptCheck.findFirst({
    where: { imageHash: verdict.imageHash, OR: [...ACCEPTED_WHERE, { contactId: { not: contact.id } }] },
  });
  if (reused) {
    kind = "suspicious";
    hard = true;
    reason = `Этот же скриншот уже присылали раньше (${reused.createdAt.toLocaleString("ru-RU")})`;
    doubts.push("этот скриншот уже присылали раньше");
  }

  // ВОЗМОЖНОЕ РЕДАКТИРОВАНИЕ СУММЫ/ДАТЫ.
  if (verdict.tamperingSuspected) {
    kind = "suspicious";
    hard = true;
    reason = `${reason} (похоже, сумма или дата на чеке отредактированы — смотрите внимательно)`;
    doubts.push("признаки подделки: сумма или дата похожи на отредактированные");
  }

  // Дата на самом чеке — МЯГКИЙ признак. Не прочиталась — не беда; давнишняя
  // или «из будущего» — повод показать человеку.
  if (kind === "valid" && verdict.receiptAt) {
    const ageHours = (Date.now() - verdict.receiptAt.getTime()) / 3_600_000;
    if (ageHours > RECEIPT_STALE_HOURS) {
      kind = "suspicious";
      hard = true;
      const days = Math.round(ageHours / 24);
      reason = `${reason} (чек старше ${RECEIPT_STALE_HOURS} ч — проверьте глазами)`;
      doubts.push(`чек давнишний (около ${days} дн.)`);
    } else if (ageHours < -RECEIPT_FUTURE_HOURS) {
      kind = "suspicious";
      hard = true;
      reason = `${reason} (дата на чеке впереди на ${Math.round(-ageHours)} ч)`;
      doubts.push("дата на чеке из будущего");
    } else if (Math.abs(ageHours) > RECEIPT_ODD_DATE_HOURS) {
      const hours = Math.round(Math.abs(ageHours));
      reason = `${reason} (дата на чеке ${ageHours > 0 ? "старше" : "впереди"} на ${hours} ч — возможно, другой часовой пояс)`;
    }
  }

  // НОМЕР ОПЕРАЦИИ. Дата больше не обязательна, поэтому старый настоящий чек,
  // пересохранённый или обрезанный (байты другие), ловим по номеру: он один на
  // перевод. Тот же номер у другого человека — стоп; у того же — это второй
  // скриншот одного перевода.
  let sameTxn = false;
  const txn = verdict.transactionId?.trim();
  if (txn && txn.length >= 6) {
    const seen = await prisma.receiptCheck.findFirst({
      where: { transactionId: txn, imageHash: { not: verdict.imageHash }, OR: ACCEPTED_WHERE },
      select: { contactId: true, createdAt: true },
    });
    if (seen && seen.contactId !== contact.id) {
      kind = "suspicious";
      hard = true;
      reason = `${reason} (номер операции ${txn} уже открывал доступ другому человеку)`;
      doubts.push("номер операции уже использован другим человеком");
    } else if (seen) {
      sameTxn = true;
    }
  }

  // ВТОРОЙ СКРИНШОТ ТОГО ЖЕ ПЕРЕВОДА: за последние минуты у человека уже есть
  // принятый (или ждущий владельца) чек почти на ту же сумму. Это не новый
  // платёж и не повод для тревоги.
  let sameTransfer: "settled" | "pending" | null = sameTxn && kind === "valid" ? "settled" : null;
  let sameTransferProven = sameTxn;
  if (kind === "valid" && amount != null && !sameTransfer) {
    const recent = await prisma.receiptCheck.findFirst({
      where: {
        contactId: contact.id,
        imageHash: { not: verdict.imageHash },
        kind: { not: "duplicate" },
        createdAt: { gte: new Date(Date.now() - SAME_TRANSFER_WINDOW_MS) },
        OR: [...ACCEPTED_WHERE, { ownerDecision: "PENDING", ownerAlerts: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      select: { amount: true, linkSent: true, ownerDecision: true, kind: true, awaitingDeliveryChoice: true, transactionId: true },
    });
    // Два РАЗНЫХ номера операции - это два перевода, а не два скриншота одного.
    const differentTxn = Boolean(recent?.transactionId && txn && txn.length >= 6 && recent.transactionId !== txn);
    if (recent?.amount != null && !differentTxn && Math.abs(recent.amount - amount) <= SAME_TRANSFER_AMOUNT_GAP) {
      sameTransfer = receiptAccepted(recent) ? "settled" : "pending";
      sameTransferProven = Boolean(recent.transactionId && txn && recent.transactionId === txn);
    }
  }

  // ПОВТОРНЫЙ ЧЕК: та же сумма уже открывала доступ за последние двое суток, но
  // это не соседний скриншот — может быть второй платёж. Не выдаём второй курс
  // за те же деньги; клиентке говорим, что уже принято, владельцу — на глаза.
  let duplicatePayment = false;
  if (kind === "valid" && amount != null && !sameTransfer) {
    const sameAmount = await prisma.receiptCheck.findFirst({
      where: {
        contactId: contact.id,
        OR: ACCEPTED_WHERE,
        amount: { gte: Math.round(amount) - SAME_TRANSFER_AMOUNT_GAP, lte: Math.round(amount) + SAME_TRANSFER_AMOUNT_GAP },
        imageHash: { not: verdict.imageHash },
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { createdAt: true },
    });
    if (sameAmount) {
      duplicatePayment = true;
      hard = true;
      kind = "suspicious";
      reason = `${reason} (такая же сумма уже открыла доступ ${sameAmount.createdAt.toLocaleString("ru-RU")} — похоже, тот же перевод прислан второй раз)`;
      doubts.push("такая же сумма уже открыла доступ — повтор или второй платёж");
    }
  }

  const plan = amount != null ? await allocate(contact.id, Math.round(amount)) : null;
  if (kind === "valid" && plan && plan.grant.length === 0 && !sameTransfer) {
    kind = "suspicious";
    hard = true;
    reason = `${reason} (${plan.note})`;
    doubts.push(plan.note);
  }

  // ВЫДАЁМ ТОЛЬКО КУРСЫ, КОТОРЫЕ ДАЁТ САМА СУММА ЧЕКА. У клиентки уже есть курс
  // за 70, пришёл старый чек на 70: полоса курса за 50 его тоже вмещает, и
  // allocate() открыл бы второй курс бесплатно. Если после вычета купленного
  // у суммы не осталось своих курсов - чек идёт владельцу.
  let ownedCache: Course[] | null = null;
  const getOwned = async (): Promise<Course[]> => (ownedCache ??= await ownedCourses(contact.id).catch(() => []));
  const own = amount != null ? await planForAmount(contact.id, amount) : null;
  const wanted = own?.wanted ?? [];
  const safeGrant = plan ? plan.grant.filter((c) => wanted.includes(c)) : [];
  if (kind === "valid" && plan && plan.grant.length > 0 && !sameTransfer && safeGrant.length !== plan.grant.length) {
    kind = "suspicious";
    hard = true;
    reason = `${reason} (эту сумму уже оплачивали: курс по ней есть, второй курс за те же деньги не открываем)`;
    doubts.push("эту сумму уже оплачивали: курс по ней уже есть - вероятно, повтор старой оплаты");
  }

  // ЧТО МЕШАЕТ АВТОПРИНЯТИЮ у чека, который сам по себе выглядит настоящим.
  // Дата здесь не участвует. Достаточно: завершённый перевод (kind valid),
  // получатель наш, сумма в допуске, валюта известна, ИИ уверен.
  const causes: string[] = [];
  if (verdict.confidence < RECEIPT_CONFIDENCE_THRESHOLD) causes.push("ИИ не уверен, что это чек");
  if (!conversionFailed && !(amount != null && Number.isFinite(amount) && amount > 0)) causes.push("сумма не прочиталась");
  if (verdict.recipientMatches !== true) causes.push("не удалось подтвердить получателя (наш номер)");
  if (!verdict.currency) causes.push("не определена валюта");
  // Ни даты, ни номера операции: у новой клиентки (первая покупка) это не повод
  // для проверки, а вот у той, кто уже покупала, - да (пересохранённый старый чек).
  if (kind === "valid" && !sameTransfer && !verdict.receiptAt && !(txn && txn.length >= 6) && (await getOwned()).length > 0) {
    causes.push("нет ни даты, ни номера операции, а у клиентки уже есть курс");
  }
  const isClean = kind === "valid" && causes.length === 0 && !sameTransfer;
  if (kind === "valid" && !sameTransfer) doubts.push(...causes);
  if (await isBotFrozen()) return;

  // ЧЕК ПРИ ШИРИН: ССЫЛКУ ОНА УЖЕ ОТПРАВИЛА САМА (владелец 11.11.2026). Чек
  // настоящий — на наш номер, сумма совпадает с курсом, повторов нет, — а ссылку
  // Ширин успела выслать руками. Дублировать ссылку не надо, но и карточка
  // «Чек требует проверки» владельцу не нужна: оплату отмечаем сами.
  // Сомнительный чек (не тот номер, сумма, повтор, подделка) по-прежнему идёт
  // владельцу — уже с пометкой, что ссылку, похоже, выдали.
  if (maybeServed && isClean && plan && plan.grant.length > 0 && queuedAt) {
    await settleManualHandout(contact, plan.grant, amount as number, verdict, existingId as string, reason, queuedAt);
    return;
  }
  if (maybeServed) {
    hard = true;
    doubts.push("похоже, Ширин уже отправила ссылку вне системы - проверьте и нажмите нужную кнопку");
  }

  let linkSent = false;
  let closedAsDuplicate: "settled" | "pending" | null = sameTransfer;
  if (isClean && !verdict.receiptAt && !(txn && txn.length >= 6)) {
    reason = `${reason} (принят автоматически без даты и номера операции)`;
  }
  if (isClean && plan && plan.grant.length > 0) {
    const granted = await withVerifiedReceiptDelivery(contact.id, verdict.imageHash, () => grantCourses(contact, plan, amount as number, verdict));
    // grantCourses can pause and roll back its own new purchase. Do not turn
    // that pause into a processed receipt, escalation or screenshot request.
    if (await isBotFrozen()) return;
    linkSent = granted.length === plan.grant.length;
    if (linkSent) {
      reason = `${reason} (${plan.note})`;
      await markExamplesAsSuccessful(contact.id).catch((err) => logError("receiptVerdict:markSuccess", err));
    } else if (await coursesAlreadyDelivered(contact.id, plan.grant)) {
      // Соседний разбор второго скриншота того же перевода успел раньше.
      closedAsDuplicate = "settled";
    }
  }
  if (!isClean && !closedAsDuplicate) {
    if (doubts.length === 0) doubts.push(verdict.kind === "suspicious" ? "ИИ счёл чек сомнительным" : "требуется взгляд человека");
    if (kind === "valid") reason = `${reason} (${causes.join("; ")})`;
  } else if (isClean && !linkSent && !closedAsDuplicate && doubts.length === 0) {
    doubts.push("доступ автоматически выдать не удалось");
  }

  // Строка в карточке и кнопка считаются ТОЙ ЖЕ функцией, что решение владельца.
  const willOpenText = own
    ? own.grant.length > 0
      ? own.grant.map((c) => COURSE_TITLE[c]).join(", ")
      : own.duplicate
        ? "ничего - курс по этой сумме у клиентки уже есть"
        : "ничего - сумма не сходится с ценами курсов"
    : null;
  const closeAsDuplicate = Boolean(own?.duplicate);
  const waitingForChoice = isClean && (await awaitingDeliveryChoice(contact.id));
  const needsOwner = !linkSent && !waitingForChoice && !closedAsDuplicate;
  const knownFraud = Boolean(blocked) || Boolean(reused);
  // «Пришлите другой скриншот» — один раз и только если чек реально нечитаем
  // (сумма/валюта/уверенность), а не при любом сомнении и не при жёстких стопах.
  const unreadable =
    verdict.confidence < RECEIPT_CONFIDENCE_THRESHOLD ||
    (!conversionFailed && amount == null) ||
    !verdict.currency ||
    (verdict.kind === "valid" && verdict.recipientMatches !== true);
  const askClientFirst = !isClean && needsOwner && !hard && unreadable && !contact.askedAltScreenshotAt;
  if (askClientFirst) reason = `${reason} (попросили клиента прислать другой скриншот)`;
  if (closedAsDuplicate) {
    reason = `${reason} (второй скриншот того же перевода — ${closedAsDuplicate === "settled" ? "доступ уже открыт" : "чек уже у владельца"})`;
  }

  const data = {
    contactId: contact.id,
    kind: closedAsDuplicate ? "duplicate" : kind,
    confidence: verdict.confidence,
    reason,
    linkSent,
    imageHash: verdict.imageHash,
    receiptAt: verdict.receiptAt,
    imageUrl: verdict.imageUrl,
    amount: amount != null ? Math.round(amount) : null,
    transactionId: txn && txn.length >= 6 ? txn : null,
    ownerDecision: needsOwner ? "PENDING" : null,
    awaitingDeliveryChoice: waitingForChoice,
    ...(closedAsDuplicate ? { decidedAt: new Date() } : {}),
  };

  let saved: { id: string } | null = null;
  if (await isBotFrozen()) return;
  if (existingId) {
    saved = await prisma.receiptCheck.update({ where: { id: existingId }, data });
  } else {
    try {
      saved = await prisma.receiptCheck.create({ data });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const existing = await prisma.receiptCheck.findUnique({ where: { imageHash: verdict.imageHash } });
      if (!existing) throw err;
      if (await isBotFrozen()) return;
      if (existing.contactId === contact.id) {
        saved = await prisma.receiptCheck.update({ where: { id: existing.id }, data });
      } else {
        logError("receiptVerdict:hashRace", new Error(`imageHash уже занят другим контактом (${existing.contactId} vs ${contact.id})`));
        saved = null;
        await notifyHashTaken(contact, existing.contactId, amount, verdict.imageUrl);
      }
    }
  }

  if (await isBotFrozen()) return;
  if (linkSent && contact.askedAltScreenshotAt) {
    await prisma.contact.update({ where: { id: contact.id }, data: { askedAltScreenshotAt: null } }).catch((err) => {
      logError("receiptVerdict:resetAltFlag", err);
    });
  }

  if (await isBotFrozen()) return;
  // Ширин сейчас ведёт разговор сама: служебные фразы клиентке («передаю Ширин»,
  // «пришлите другой скрин», «уже приняли») не шлём — дверь отправки их всё равно
  // не пропустит, а владельцу нужна только карточка. Ссылку на уроки выдаёт
  // grantCourses выше через проверенный чек — это единственное исключение.
  const humanTalking = contactAutomationBlocked(contact);
  if (humanTalking) {
    if (saved && (needsOwner || duplicatePayment) && !closedAsDuplicate) {
      await askOwner(contact, saved.id, { ...verdict, amount }, doubts, verdict.reason, willOpenText, closeAsDuplicate);
    }
    return;
  }
  if (saved && closedAsDuplicate === "settled") {
    await tellAlreadyAccepted(contact);
    if (!sameTransferProven) {
      await notifyOwnerText(contact, `второй скриншот принят как повтор уже принятого перевода (${amount != null ? Math.round(amount * 100) / 100 : "?"} сомони), номер операции не подтвердил. Если это новый перевод - откройте чек в панели.`);
    }
  } else if (saved && closedAsDuplicate === "pending") {
    // Молчим: человек уже получил «передаю Ширин», карточка у владельца одна.
  } else if (saved && askClientFirst) {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const text = ALT_SCREENSHOT_TEXT[await contactLanguage(contact.id, lastIn?.text ?? "")];
    if (await isBotFrozen()) return;
    await sendToContact(contact, text)
      .then((mid) => {
        if (mid) return recordOutgoingMessage(contact.id, text, mid);
      })
      .catch((err) => logError("receiptVerdict:askAltScreenshot", err));
    if (await isBotFrozen()) return;
    await prisma.contact.update({ where: { id: contact.id }, data: { askedAltScreenshotAt: new Date() } }).catch((err) => {
      logError("receiptVerdict:setAltFlag", err);
    });
  } else if (saved && duplicatePayment) {
    // Если клиентка ждёт вопроса про Telegram и вопрос уже задан, "принято" не
    // скажешь - ссылки ещё нет: тогда обычное "чек получила, передаю Ширин".
    const told = await tellAlreadyAccepted(contact);
    if (!told) await notifyCustomerReceiptForwarded(contact, saved);
    if (await isBotFrozen()) return;
    await askOwner(contact, saved.id, { ...verdict, amount }, doubts, verdict.reason, willOpenText, closeAsDuplicate);
  } else if (saved && needsOwner) {
    if (contact.askedAltScreenshotAt) {
      await prisma.contact.update({ where: { id: contact.id }, data: { askedAltScreenshotAt: null } }).catch((err) => {
        logError("receiptVerdict:resetAltFlagAfterSecond", err);
      });
    }
    await askOwner(contact, saved.id, { ...verdict, amount }, doubts, verdict.reason, willOpenText, closeAsDuplicate);
    // Мошеннику (чёрный список, повторный скриншот) ничего не обещаем —
    // владелец сам решит, что ему сказать.
    if (!knownFraud && !maybeServed) await notifyCustomerReceiptForwarded(contact, saved);
  }
}
