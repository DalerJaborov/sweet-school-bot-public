import { prisma, logError } from "../db.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { ACCEPTED_WHERE } from "../receiptAccepted.js";
import type { ClientLanguage } from "./clientLanguage.js";

/**
 * РЕКВИЗИТЫ И «ПРИШЛИТЕ ЧЕК» — НЕ ЧАЩЕ ОДНОГО РАЗА (владелец 11.11.2026).
 *
 * Разбор 48 часов переписок: номер и «фиристед чек» уходили 3–5 раз за пару
 * минут. Источников четыре, и каждый сам по себе прав: шаг воронки с номером,
 * ответ ИИ («как оплатить?»), повторный ответ ИИ на следующий пузырь и
 * подтверждение экрана перевода. Вместе — назойливость, от которой уходят.
 * И хуже: чек просили у того, кто уже заплатил и получил ссылку.
 *
 * ОДНА ДВЕРЬ на весь класс: и ai.ts (ответ модели), и funnel.ts (шаг воронки)
 * спрашивают здесь, можно ли сейчас назвать номер или попросить чек.
 *
 *  - номер уже был в наших сообщениях за последние REPEAT_WINDOW_MS — не повторяем;
 *  - «пришлите чек» уже просили за то же окно — не повторяем;
 *  - человек уже оплатил и получил ссылку (покупка с выданной ссылкой) — чек не
 *    просим никогда, номер не шлём, если он сам не спросил про второй курс;
 *  - «чек получили / приняли» без принятого чека — не говорим (ложное «принято»).
 */
export const REPEAT_WINDOW_MS = 15 * 60_000;
/** Сколько наших последних сообщений смотреть, кроме окна по времени. */
const RECENT_OUT = 8;

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** Есть ли в тексте наш номер для оплаты (с пробелами, дефисами, кодом 992). */
export function mentionsPaymentPhone(text: string, phone: string): boolean {
  const want = digitsOf(phone);
  if (want.length < 6) return false;
  return digitsOf(text).includes(want);
}

/** Просьба прислать чек — по-русски и по-таджикски, в любой форме. */
const RECEIPT_ASK =
  /(пришлите|присылайте|скиньте|отправьте|скинь|пришли|киньте)[^.!?\n]{0,25}(чек|скрин|квитанц)|(чек|скрин)\p{L}*[^.!?\n]{0,25}(пришлите|скиньте|отправьте|фирист\p{L}*|равон\s+кун\p{L}*|партоед|партоен|монед|монен)|(фиристед|фиристен|равон\s+кунед|партоед)[^.!?\n]{0,15}чек/iu;

export function asksForReceipt(text: string): boolean {
  return RECEIPT_ASK.test(text);
}

/** «Чек получили», «Кабул кардем», «Оплата принята» — подтверждение оплаты. */
const RECEIPT_ACK =
  /(кабул\s+кард(ем|ам|им)|қабул\s+кард(ем|ам|им)|кабул\s+шуд|қабул\s+шуд|чек\p{L}*\s+(гирифт(ем|ам)|омад)|(оплат\p{L}*|чек|перевод)\s+(принят|получ\p{L}+)|(принял[аи]?|получил[аи]?)\s+(ваш\s+)?(чек|оплату|перевод))/iu;

export function claimsReceiptAccepted(text: string): boolean {
  return RECEIPT_ACK.test(text);
}

/** Человек спрашивает про ВТОРОЙ курс или прямо про реквизиты — тогда номер уместен и после оплаты. */
const WANTS_MORE =
  /(второй|другой|ещё\s+один|еще\s+один|дигар|дуюм|боз\s+як)\s*курс|(арт|21)[^.!?\n]{0,20}(тоже|хам|ҳам)|(куда|как)\s+(перев|оплат|скинуть|отправить)|номер\p{L}*\s*(карт|для|барои)|(ракам|номер)\p{L}*\s*(дихед|диҳед|нависед|партоед)|(чи\s*хел|чихел|чӣ\s*хел)\s+(пардохт|пул\s+партоям|гузаронам)/iu;

export function clientWantsToPayAgain(text: string): boolean {
  return WANTS_MORE.test(text ?? "");
}

export type RepeatContext = {
  phone: string;
  /** Номер уже был в наших недавних сообщениях. */
  requisitesSentRecently: boolean;
  /** «Пришлите чек» уже звучало недавно. */
  receiptAskedRecently: boolean;
  /** Оплатил и получил ссылку. */
  paidWithAccess: boolean;
  /** Есть принятый чек — можно говорить «принято». */
  hasAcceptedReceipt: boolean;
  /** Клиент в этом ходе сам спросил про оплату второго курса / реквизиты. */
  clientAsksToPay: boolean;
};

async function recentOutgoing(contactId: string): Promise<string[]> {
  try {
    const rows = await prisma.message.findMany({
      where: { contactId, direction: "OUT", text: { not: null } },
      orderBy: { createdAt: "desc" },
      take: RECENT_OUT,
      select: { text: true, createdAt: true },
    });
    const since = Date.now() - REPEAT_WINDOW_MS;
    return (rows ?? []).filter((r) => r.createdAt && r.createdAt.getTime() >= since).map((r) => r.text ?? "");
  } catch (err) {
    logError("repeatGuard:recent", err);
    return [];
  }
}

/** Оплатил и ссылка выдана (действующая покупка с выданной ссылкой). */
export async function hasDeliveredAccess(contactId: string): Promise<boolean> {
  try {
    const n = await prisma.purchase.count({ where: { contactId, revokedAt: null, inviteLink: { not: null } } });
    return (n ?? 0) > 0;
  } catch (err) {
    logError("repeatGuard:access", err);
    return false;
  }
}

async function hasAcceptedReceipt(contactId: string): Promise<boolean> {
  try {
    const n = await prisma.receiptCheck.count({
      where: { contactId, OR: ACCEPTED_WHERE },
    });
    return (n ?? 0) > 0;
  } catch (err) {
    logError("repeatGuard:receipt", err);
    return false;
  }
}

export async function loadRepeatContext(contactId: string, clientText: string): Promise<RepeatContext> {
  const [texts, recent, paidWithAccess, accepted] = await Promise.all([
    getSalesTexts(),
    recentOutgoing(contactId),
    hasDeliveredAccess(contactId),
    hasAcceptedReceipt(contactId),
  ]);
  return {
    phone: texts.paymentPhone,
    requisitesSentRecently: recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone)),
    receiptAskedRecently: recent.some((t) => asksForReceipt(t)),
    paidWithAccess,
    hasAcceptedReceipt: accepted,
    clientAsksToPay: clientWantsToPayAgain(clientText),
  };
}

const ALREADY_WROTE_NUMBER: Record<ClientLanguage, string> = {
  ru: "Номер я написала выше",
  tg: "Номерро болотар навиштам",
  en: "I wrote the number above",
};

/** Предложения ответа (по строкам и по точкам), чтобы вырезать лишнее, не ломая остальное. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Убирает из ответа модели то, что сейчас повторять нельзя. Возвращает текст
 * (возможно пустой — тогда отвечать нечего) и что убрано — для журнала.
 */
export function withoutRepeats(
  reply: string,
  ctx: RepeatContext,
  language: ClientLanguage,
): { text: string; removed: string[] } {
  const removed = new Set<string>();
  const dropRequisites = ctx.requisitesSentRecently || (ctx.paidWithAccess && !ctx.clientAsksToPay);
  const dropReceiptAsk = ctx.receiptAskedRecently || (ctx.paidWithAccess && !ctx.clientAsksToPay);
  const kept = sentences(reply).filter((s) => {
    if (dropRequisites && mentionsPaymentPhone(s, ctx.phone)) {
      removed.add("requisites");
      return false;
    }
    if (dropReceiptAsk && asksForReceipt(s)) {
      removed.add("receipt_ask");
      return false;
    }
    if (!ctx.hasAcceptedReceipt && claimsReceiptAccepted(s)) {
      removed.add("false_receipt_ack");
      return false;
    }
    return true;
  });
  if (removed.size === 0) return { text: reply, removed: [] };
  let text = kept.join("\n").trim();
  // Человек переспросил номер, а он только что был: короткое «номер выше», а не тишина.
  if (!text && removed.has("requisites") && ctx.requisitesSentRecently && !ctx.paidWithAccess) {
    text = ALREADY_WROTE_NUMBER[language];
  }
  return { text, removed: [...removed] };
}

/**
 * Шаг воронки с реквизитами: пропустить текст, если номер только что уходил или
 * человек уже оплатил и получил ссылку. Ошибка базы — шлём как обычно.
 */
export async function shouldSkipRequisitesStep(contactId: string, stepText: string): Promise<boolean> {
  try {
    const texts = await getSalesTexts();
    if (!mentionsPaymentPhone(stepText, texts.paymentPhone)) return false;
    if (await hasDeliveredAccess(contactId)) return true;
    const recent = await recentOutgoing(contactId);
    return recent.some((t) => mentionsPaymentPhone(t, texts.paymentPhone));
  } catch (err) {
    logError("repeatGuard:step", err);
    return false;
  }
}
