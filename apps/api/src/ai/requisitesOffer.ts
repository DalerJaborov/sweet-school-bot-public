import { logError } from "../db.js";
import { COURSE_50, COURSE_70, type PriceTable } from "../prices.js";
import { getPrices } from "../services/priceService.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import type { ClientLanguage } from "./clientLanguage.js";
import { priceOrChoice, type PriceTopic } from "./paymentIntent.js";
import { paymentLine, type SalesTexts } from "./prompts.js";
import {
  ALREADY_WROTE_NUMBER,
  mentionsPaymentPhone,
  ownsAllCourses,
  requisitesDeclined,
  requisitesRecentlySent,
  tryClaimRequisites,
} from "./repeatGuard.js";

/**
 * ЦЕНА И НОМЕР КАРТЫ ОДНИМ СООБЩЕНИЕМ (владелец 16.11.2026: «Да, исправляй»).
 *
 * Разбор 16.11: после #86 бот на «чанд?» и «хочу купить» отвечал «Хотите,
 * реквизиты отправлю?», лишний шаг, и люди уходили. Теперь, если клиент спросил
 * цену, сказал «хочу купить» или выбрал курс, в ответе ИИ цена и номер стоят
 * вместе, одним сообщением. Вопрос «отправить ли номер?» вырезается всегда:
 * правило в промпте (ai/prompts.ts, правило 23) и этот фильтр в коде.
 *
 * Дух #86 сохранён: номер не повторяем за окно повтора (repeatGuard), не
 * приклеиваем к ответу на другую тему, не навязываем после «не надо / позже»,
 * не шлём купившему оба курса. Номер и получатель берутся из «Тексты и цены»
 * (paymentPhone и др.), цены из «Цены и даты»: в коде их нет.
 */

/** «Хотите, отправлю реквизиты?», «Реквизитҳоро фиристам?», «Если хотите, подскажу, как оформить». */
const OFFER_QUESTION = new RegExp(
  [
    "(хотите|хотели\\s+бы|могу|можно|давайте|нужн\\p{L}*|скинуть|отправить|прислать|написать|подсказать|дать)[^.!?\\n]{0,40}(реквизит|номер\\p{L}*\\s*(карт|для\\s+оплат)|как\\s+оформить|как\\s+оплатить|куда\\s+перев)[^.!?\\n]*\\?",
    "если\\s+(хотите|нужно|будете\\s+готов\\p{L}*)[^.!?\\n]{0,30}(подскаж|отправ|скин|напиш|пришл|дам)\\p{L}*[^.!?\\n]{0,30}(оформ|оплат|реквизит|номер)",
    "(реквизит\\p{L}*|ра[қк]ам\\p{L}*\\s*(и\\s*)?(корт|карт)\\p{L}*|номер\\p{L}*\\s*(корт|карт)\\p{L}*)[^.!?\\n]{0,40}(фиристам|фиристем|равон\\s+кунам|равон\\s+кунем|нависам|партоям|ди[ҳх]ам)\\s*\\?",
    "агар\\s+(хо[ҳх]ед|хохиш\\s+доред|майлатон)[^.!?\\n]{0,40}(реквизит|ра[қк]ам|номер|пардохт|чи\\s*[хҳ]ел\\s+харидан)",
  ].join("|"),
  "iu",
);

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Вырезает вопрос «отправить ли номер?» (кроме фразы, где номер уже есть). */
export function withoutOfferQuestion(reply: string, phone: string): { text: string; removed: boolean } {
  let removed = false;
  const kept = sentences(reply).filter((s) => {
    if (s === "---") return true;
    if (OFFER_QUESTION.test(s) && !mentionsPaymentPhone(s, phone)) {
      removed = true;
      return false;
    }
    return true;
  });
  return removed ? { text: kept.join("\n").trim(), removed } : { text: reply, removed };
}

/** Цена названного курса (или всех) одной фразой. */
export function priceSentence(topic: PriceTopic, p: PriceTable, language: ClientLanguage): string {
  const tg = language === "tg";
  const c70 = p.price[COURSE_70];
  const c50 = p.price[COURSE_50];
  const cur = tg ? "сомонӣ" : "сомони";
  const t70 = `21 рецепт ${c70} ${cur}`;
  const t50 = tg ? `арт десерт ${c50} ${cur}` : `арт-десерты ${c50} ${cur}`;
  const both = tg ? `ҳарду курс якҷоя ${p.bundle} ${cur}` : `оба курса вместе ${p.bundle} ${cur}`;
  let line: string;
  if (topic.bundle) line = both;
  else if (topic.courses.length === 1) line = topic.courses[0] === COURSE_70 ? t70 : t50;
  else line = `${t70}, ${t50}, ${both}`;
  return `${line.charAt(0).toLocaleUpperCase("ru-RU")}${line.slice(1)}.`;
}

export function requisitesSentence(t: Pick<SalesTexts, "paymentPhone" | "paymentRecipient" | "paymentBanks">, language: ClientLanguage): string {
  const lead = language === "tg" ? "Рақами корт барои пардохт" : language === "en" ? "Card number for payment" : "Номер карты для оплаты";
  return `${lead}: ${paymentLine(t)}`;
}

/** Есть ли в ответе цена того, о чём спросили. Курс не назван — хватит любой цены:
 *  модель уже ответила про цену, добавляем только номер. */
function hasPrice(reply: string, topic: PriceTopic, p: PriceTable): boolean {
  const has = (n: number) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(reply);
  if (topic.bundle) return has(p.bundle);
  if (topic.courses.length === 1) return has(p.price[topic.courses[0]]);
  return [p.price[COURSE_70], p.price[COURSE_50], p.bundle].some(has);
}

export type OfferResult = {
  text: string;
  /** В ответе есть номер карты: слать одним сообщением, не голосом. */
  carriesRequisites: boolean;
  /** Что сделали — для журнала. */
  action: "none" | "appended" | "kept" | "dropped_race" | "question_removed";
};

/**
 * Довести ответ ИИ до «цена + номер» или убрать вопрос «отправить номер?».
 * Захват «номер шлю я» (repeatGuard) ставится здесь, если номер остаётся в ответе.
 */
export async function applyRequisitesOffer(
  contactId: string,
  clientText: string,
  reply: string,
  language: ClientLanguage,
): Promise<OfferResult> {
  try {
    const texts = await getSalesTexts();
    const phone = texts.paymentPhone;
    const cleaned = withoutOfferQuestion(reply, phone);
    let text = cleaned.text;

    if (mentionsPaymentPhone(text, phone)) {
      // Номер написала сама модель. Захват синхронный: если его только что взял
      // шаг воронки, номер из ответа убираем, он придёт шагом.
      if (tryClaimRequisites(contactId)) return { text, carriesRequisites: true, action: "kept" };
      const rest = sentences(text)
        .filter((s) => !mentionsPaymentPhone(s, phone))
        .join("\n")
        .trim();
      return { text: rest || ALREADY_WROTE_NUMBER[language], carriesRequisites: false, action: "dropped_race" };
    }

    const topic = priceOrChoice(clientText);
    const allowed =
      topic !== null &&
      !(await ownsAllCourses(contactId)) &&
      !(await requisitesDeclined(contactId, clientText)) &&
      !(await requisitesRecentlySent(contactId, phone));
    const prices = allowed ? await getPrices() : null;
    // Последним и без await: проверка захвата и его запись — одной синхронной операцией.
    if (topic && prices && tryClaimRequisites(contactId)) {
      const add = (hasPrice(text, topic, prices) ? "" : `${priceSentence(topic, prices, language)} `) + requisitesSentence(texts, language);
      text = text ? `${text}\n${add}` : add;
      return { text, carriesRequisites: true, action: "appended" };
    }
    // Номер сейчас не к месту, а ответ был одним вопросом «отправить номер?» —
    // лучше оставить его как есть, чем промолчать.
    if (!text) return { text: reply, carriesRequisites: false, action: "none" };
    return { text, carriesRequisites: false, action: cleaned.removed ? "question_removed" : "none" };
  } catch (err) {
    logError("requisitesOffer", err);
    return { text: reply, carriesRequisites: false, action: "none" };
  }
}
