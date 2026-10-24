import { Prisma } from "@prisma/client";
import type { Contact } from "@prisma/client";
import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { isBotFrozen } from "../messaging/automation.js";
import { sendReceiptForReview } from "../telegram.js";
import { allocate } from "../courses.js";
import { toSomoni } from "../exchangeRates.js";
import { markExamplesAsSuccessful } from "./styleLearning.js";
import { detectClientLanguage, type ClientLanguage } from "./clientLanguage.js";
import { grantCourses } from "./grantCourses.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { paymentLine } from "./prompts.js";

const RECEIPT_CONFIDENCE_THRESHOLD = 50;

/** Просим прислать другой скриншот чека (другой ракурс/из истории банка) —
 *  решение владельца 25.08.2026 веч.: сначала дать клиенту шанс самому
 *  разобраться, а не сразу звать владельца на каждый нечёткий чек. */
const ALT_SCREENSHOT_TEXT: Record<ClientLanguage, string> = {
  ru: "Чек не совсем понятно читается 🙏 Пришлите, пожалуйста, ещё один — можно из истории банка или под другим углом, так быстрее разберёмся.",
  tg: "Чек чандон возеҳ дида намешавад 🙏 Лутфан сурати дигар фиристед — метавонед аз таърихи бонк гиред ё аз кунҷи дигар суратгирӣ кунед.",
  en: "Hi! The receipt isn't fully readable — could you send another one? From your bank history or a different angle works too.",
};

/**
 * ЭКРАН ДО ПЕРЕВОДА (05.09.2026). Клиентка ввела наш номер в банке, увидела имя
 * получателя и прислала скриншот: «правильно?». Раньше это шло как «нечёткий
 * чек» с просьбой прислать ещё — человек пугался. Теперь отвечаем по делу:
 * да, номер и имя верные, переводите и присылайте чек. Реквизиты — из той же
 * таблицы «Тексты и цены», что у бота.
 */
export async function confirmRequisitesToCustomer(contact: Contact, lastText: string | null): Promise<void> {
  const texts = await getSalesTexts();
  const line = paymentLine(texts);
  const byLang: Record<ClientLanguage, string> = {
    ru: `Да, всё верно: ${line} — это наш номер, получатель ${texts.paymentRecipient}. Переводите и пришлите сюда чек — открою доступ.`,
    tg: `Ҳа, ҳамааш дуруст: ${line} — рақами мо, қабулкунанда ${texts.paymentRecipient}. Интиқол кунед ва чекро ҳамин ҷо фиристед — дастрасиро мекушоям.`,
    en: `Yes, that's correct: ${line} — our number, recipient ${texts.paymentRecipient}. Send the transfer and the receipt here, and I'll open access.`,
  };
  const lastIn = lastText?.trim()
    ? { text: lastText }
    : await prisma.message.findFirst({
        where: { contactId: contact.id, direction: "IN", text: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { text: true },
      });
  const text = byLang[detectClientLanguage(lastIn?.text ?? "")];
  const mid = await sendToContact(contact, text);
  if (mid) await recordOutgoingMessage(contact.id, text, mid);
}

/** Тот же перевод прислан второй раз (та же сумма за последние двое суток уже
 *  открыла доступ). Раньше 70 сомони дважды открывали ВТОРОЙ курс как новую покупку. */
const DUPLICATE_WINDOW_MS = 48 * 3_600_000;
const DUPLICATE_PAYMENT_TEXT: Record<ClientLanguage, string> = {
  ru: "Этот перевод мы уже приняли — ссылка на уроки выше в этом чате 🙂 Если это другая оплата, напишите, разберёмся.",
  tg: "Ин интиқолро аллакай қабул кардем — пайванд ба дарсҳо болотар дар ҳамин чат аст 🙂 Агар ин пардохти дигар бошад, нависед, мефаҳмем.",
  en: "We've already accepted this transfer — the lesson link is above in this chat 🙂 If this is a different payment, let us know.",
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
  ru: "Чек получила, передаю Ширин на проверку. Ссылка на уроки придёт сюда же — обычно в течение часа, ночью — утром.",
  tg: "Чекро гирифтам, ба Ширин барои тафтиш медиҳам. Пайванд ба дарсҳо ҳамин ҷо меояд — одатан дар давоми як соат, шабона — пагоҳӣ.",
  en: "Got your receipt, passing it to Shirin to check. The lesson link will arrive right here — usually within an hour, overnight — in the morning.",
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
  const text = FORWARDED_TO_OWNER_TEXT[detectClientLanguage(lastIn?.text ?? "")];
  if (await isBotFrozen()) return;
  await sendToContact(contact, text)
    .then((mid) => {
      if (mid) return recordOutgoingMessage(contact.id, text, mid);
    })
    .catch((err) => logError("receiptVerdict:notifyCustomerForwarded", err));
}

/** Чек месячной давности — это уже не «забыл отправить», такой стоит показать человеку глазами. */
const RECEIPT_ANCIENT_DAYS = 30;
/** С какого расхождения дату стоит УПОМЯНУТЬ владельцу в карточке (не блокируя):
 *  полсуток покрывают любой часовой пояс и любое «отправил на следующий день». */
const RECEIPT_ODD_DATE_HOURS = 12;

/** Карточка сомнительного чека владельцу в Telegram — с фото и кнопками
 *  «Подтвердить»/«Отклонить». Если Telegram не настроен, чек просто остаётся во
 *  вкладке «Чеки» панели: тихо потерять его нельзя. */
async function askOwner(
  contact: Contact,
  receiptId: string,
  verdict: { amount: number | null; receiptAt: Date | null; imageUrl: string | null },
  reason: string
): Promise<void> {
  if (await isBotFrozen()) return;
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken || !verdict.imageUrl) return;

  const recipients = [
    ...new Set(
      [
        (await getSetting("telegramOwnerChatId"))?.trim(),
        (await getSetting("telegramReportChatId"))?.trim(),
      ].filter((id): id is string => Boolean(id))
    ),
  ];
  if (recipients.length === 0) return;

  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const caption =
    `💳 Чек требует проверки\nОт: ${who}\n` +
    `Сумма: ${verdict.amount != null ? `${verdict.amount} сомони` : "не разобрана"}\n` +
    `Дата на чеке: ${verdict.receiptAt ? verdict.receiptAt.toLocaleString("ru-RU") : "не разобрана"}\n` +
    `Причина: ${reason}`;

  const needsCourseChoice = verdict.amount == null;
  for (const chatId of recipients) {
    if (await isBotFrozen()) return;
    await sendReceiptForReview(botToken, chatId, { imageUrl: verdict.imageUrl, caption, receiptId, needsCourseChoice });
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
    imageHash: string;
    imageUrl: string | null;
  },
  existingId?: string
): Promise<void> {
  if (await isBotFrozen()) return;
  let kind = verdict.kind;
  let reason = verdict.reason;

  // ЧЕК ИЗ-ЗА ГРАНИЦЫ. Переводим по текущему курсу и дальше работаем уже с сомони.
  let amount = verdict.amount;
  const currency = (verdict.currency ?? "TJS").toUpperCase();
  if (amount != null && currency !== "TJS") {
    const converted = await toSomoni(amount, currency);
    if (converted == null) {
      kind = "suspicious";
      reason = `${reason} (чек в ${currency}, курс сейчас недоступен — проверьте сумму сами)`;
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
    reason = `В чёрном списке: ${blocked.reason}`;
  }

  // Тот же скриншот уже открывал доступ раньше.
  const reused = await prisma.receiptCheck.findFirst({ where: { imageHash: verdict.imageHash, linkSent: true } });
  if (reused) {
    kind = "suspicious";
    reason = `Этот же скриншот уже открывал доступ раньше (${reused.createdAt.toLocaleString("ru-RU")})`;
  }

  // ВОЗМОЖНОЕ РЕДАКТИРОВАНИЕ СУММЫ/ДАТЫ.
  if (verdict.tamperingSuspected) {
    kind = "suspicious";
    reason = `${reason} (похоже, сумма или дата на чеке отредактированы — смотрите внимательно)`;
  }

  // Дата на самом чеке.
  if (kind === "valid" && verdict.receiptAt) {
    const ageHours = (Date.now() - verdict.receiptAt.getTime()) / 3_600_000;
    if (ageHours > RECEIPT_ANCIENT_DAYS * 24) {
      kind = "suspicious";
      reason = `${reason} (чек старше ${RECEIPT_ANCIENT_DAYS} дней — проверьте глазами)`;
    } else if (Math.abs(ageHours) > RECEIPT_ODD_DATE_HOURS) {
      const hours = Math.round(Math.abs(ageHours));
      reason = `${reason} (дата на чеке ${ageHours > 0 ? "старше" : "впереди"} на ${hours} ч — возможно, другой часовой пояс)`;
    }
  }

  // ПОВТОРНЫЙ ЧЕК: та же сумма уже открывала доступ за последние двое суток —
  // почти наверняка тот же перевод прислан ещё раз (другой скриншот того же
  // чека). Не выдаём второй курс за те же деньги; клиентке говорим, что уже
  // принято, владельцу — на глаза, а не в автомат.
  let duplicatePayment = false;
  if (kind === "valid" && amount != null) {
    const sameAmount = await prisma.receiptCheck.findFirst({
      where: {
        contactId: contact.id,
        linkSent: true,
        amount: Math.round(amount),
        imageHash: { not: verdict.imageHash },
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { createdAt: true },
    });
    if (sameAmount) {
      duplicatePayment = true;
      kind = "suspicious";
      reason = `${reason} (такая же сумма уже открыла доступ ${sameAmount.createdAt.toLocaleString("ru-RU")} — похоже, тот же перевод прислан второй раз)`;
    }
  }

  const plan = amount != null ? await allocate(contact.id, amount) : null;
  if (kind === "valid" && plan && plan.grant.length === 0) {
    kind = "suspicious";
    reason = `${reason} (${plan.note})`;
  }

  const isClean = kind === "valid" && verdict.confidence >= RECEIPT_CONFIDENCE_THRESHOLD && amount != null;
  if (await isBotFrozen()) return;

  let linkSent = false;
  if (isClean && plan && plan.grant.length > 0) {
    const granted = await grantCourses(contact, plan, amount as number, verdict);
    // grantCourses can pause and roll back its own new purchase. Do not turn
    // that pause into a processed receipt, escalation or screenshot request.
    if (await isBotFrozen()) return;
    linkSent = granted.length > 0;
    if (linkSent) {
      reason = `${reason} (${plan.note})`;
      await markExamplesAsSuccessful(contact.id).catch((err) => logError("receiptVerdict:markSuccess", err));
    }
  }

  const needsOwner = !linkSent;
  const knownFraud = Boolean(blocked) || Boolean(reused);
  const askClientFirst = needsOwner && !knownFraud && !duplicatePayment && !contact.askedAltScreenshotAt;
  if (askClientFirst) reason = `${reason} (попросили клиента прислать другой скриншот)`;

  const data = {
    contactId: contact.id,
    kind,
    confidence: verdict.confidence,
    reason,
    linkSent,
    imageHash: verdict.imageHash,
    receiptAt: verdict.receiptAt,
    imageUrl: verdict.imageUrl,
    amount: amount != null ? Math.round(amount) : null,
    ownerDecision: needsOwner ? "PENDING" : null,
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
  if (saved && askClientFirst) {
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const text = ALT_SCREENSHOT_TEXT[detectClientLanguage(lastIn?.text ?? "")];
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
    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN", text: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    const text = DUPLICATE_PAYMENT_TEXT[detectClientLanguage(lastIn?.text ?? "")];
    if (await isBotFrozen()) return;
    await sendToContact(contact, text)
      .then((mid) => (mid ? recordOutgoingMessage(contact.id, text, mid) : undefined))
      .catch((err) => logError("receiptVerdict:duplicateNotice", err));
    if (await isBotFrozen()) return;
    await askOwner(contact, saved.id, verdict, reason);
  } else if (saved && needsOwner) {
    if (contact.askedAltScreenshotAt) {
      await prisma.contact.update({ where: { id: contact.id }, data: { askedAltScreenshotAt: null } }).catch((err) => {
        logError("receiptVerdict:resetAltFlagAfterSecond", err);
      });
      reason = `${reason} (уже просили прислать другой скриншот)`;
    }
    await askOwner(contact, saved.id, verdict, reason);
    // Мошеннику (чёрный список, повторный скриншот) ничего не обещаем —
    // владелец сам решит, что ему сказать.
    if (!knownFraud) await notifyCustomerReceiptForwarded(contact, saved);
  }
}
