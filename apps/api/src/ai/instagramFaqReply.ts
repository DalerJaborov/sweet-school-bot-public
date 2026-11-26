import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { getPrices } from "../services/priceService.js";
import { getSalesTexts } from "../services/salesTextsService.js";
import { conversationLanguage, type ClientLanguage } from "./clientLanguage.js";
import {
  detectInstagramFaq,
  instagramFaqAnswer,
  instagramFaqFact,
  parseFaqExtras,
  type FaqExtras,
  type InstagramFaq,
} from "./instagramFaq.js";

/**
 * ОТВЕТ НА ГОТОВЫЙ ВОПРОС INSTAGRAM / РЕКЛАМЫ — одна дверь для воронки (первое
 * сообщение: ответ + меню) и для ai.ts (меню уже было: ответ с вопросом дальше).
 */

/** Настройка: дополнительные тексты вопросов, строки «вид: текст». Дополняет список кода. */
export const INSTAGRAM_FAQ_EXTRA_SETTING = "instagramFaqExtra";

export async function loadFaqExtras(): Promise<FaqExtras> {
  try {
    return parseFaqExtras(await getSetting(INSTAGRAM_FAQ_EXTRA_SETTING));
  } catch (err) {
    logError("instagramFaq:extras", err);
    return new Map();
  }
}

export async function detectFaq(text: string | null | undefined): Promise<InstagramFaq | null> {
  if (!text?.trim()) return null;
  return detectInstagramFaq(text, await loadFaqExtras());
}

/**
 * Язык ответа на готовый вопрос: по-таджикски, если человек сам по-русски ещё не
 * писал (владелец 16.11.2026). Готовые вопросы и нажатия кнопок — не его слова,
 * их не считаем. Писал своими словами по-русски (или по-английски) — на том же языке.
 */
export async function faqLanguage(contactId: string): Promise<ClientLanguage> {
  try {
    const [rows, extras] = await Promise.all([
      prisma.message.findMany({
        where: { contactId, direction: "IN", text: { not: null }, payload: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { text: true },
      }),
      loadFaqExtras(),
    ]);
    const own = (rows ?? []).map((r) => r.text).filter((t) => !detectInstagramFaq(t, extras));
    const lang = conversationLanguage(own);
    if (lang === "ru" || lang === "en") return lang;
  } catch (err) {
    logError("instagramFaq:language", err);
  }
  return "tg";
}

const GREETING: Record<ClientLanguage, string> = {
  tg: "Ассалому алейкум!",
  ru: "Здравствуйте!",
  en: "Hello!",
};

/**
 * Отправить ответ. withMenu — следом уйдёт меню воронки с кнопками: тогда только
 * суть, без вопроса «какой курс?» (его задают кнопки). Приветствие ставим всегда:
 * дверь отправки сама срежет его, если сегодня уже здоровались (greeting.ts), а меню
 * следом своё приветствие потеряет по тому же правилу. true — что-то ушло.
 */
export async function replyToInstagramFaq(
  contact: { id: string; igUserId: string; channel: string },
  kind: InstagramFaq,
  opts: { withMenu: boolean },
): Promise<boolean> {
  const [language, prices, texts] = await Promise.all([faqLanguage(contact.id), getPrices(), getSalesTexts()]);
  const body = opts.withMenu
    ? instagramFaqFact(kind, language, prices, texts)
    : instagramFaqAnswer(kind, language, prices, texts);
  const [first, ...rest] = body.split("\n").filter(Boolean);
  let sent = false;
  for (const part of [`${GREETING[language]} ${first}`, ...rest]) {
    const mid = await sendToContact(contact, part);
    if (mid) {
      await recordOutgoingMessage(contact.id, part, mid);
      sent = true;
    }
  }
  return sent;
}
