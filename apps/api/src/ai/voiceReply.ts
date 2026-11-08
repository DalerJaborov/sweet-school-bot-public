import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { sendAttachmentToContact } from "../messaging/send.js";
import { synthesizeToFile, voiceEnabled } from "./voiceClone.js";

/**
 * ГДЕ БОТ ОТВЕЧАЕТ ГОЛОСОМ, А ГДЕ ТЕКСТОМ (владелец 08.11.2026, «бот сам решает»).
 *
 * Рубильник `voiceReplyEnabled` ВЫКЛЮЧЕН по умолчанию: включает владелец после
 * того, как послушает примеры. Кроме него нужны ключ ElevenLabs и `voiceCloneEnabled`.
 *
 * ПРАВИЛО.
 *  - Голосом: короткий тёплый ответ (приветствие, адрес, как записаться).
 *    Если клиент сам прислал голосовое, порог длины мягче.
 *  - Текстом ВСЕГДА: ссылки, любые суммы и числа (цены), реквизиты и карты,
 *    списки из нескольких строк, длинное. Деньги на слух легко перепутать.
 *  - Не больше одного голосового подряд: если прошлый ответ бота был голосовым —
 *    теперь текст.
 *  - Только WhatsApp (мост шлёт настоящее голосовое). Остальные каналы — текстом.
 *  - Любая ошибка озвучки (потолок трат, сеть) — молча отвечаем текстом.
 */
export const VOICE_MARK = "🎤 ";
const MAX_WARM = 160;
const MAX_AFTER_CLIENT_VOICE = 240;

const HAS_LINK = /https?:|www\.|\b[\w-]+\.(?:com|online|ru|tj|org|net)\b|@\w{3,}/i;
const HAS_MONEY_OR_NUMBER = /\d{2,}|сомон|сомони|сум\b|руб|₽|\$|usd|tjs|нарх|цена|стоит/i;
const HAS_REQUISITES = /карт[аыу]|реквизит|счёт|счет|перевод|оплат/i;

export function chooseVoiceOrText(
  text: string,
  ctx: { channel: string; clientSentVoice: boolean; lastReplyWasVoice: boolean }
): "voice" | "text" {
  if (ctx.channel !== "WHATSAPP" || ctx.lastReplyWasVoice) return "text";
  const t = text.trim();
  if (!t || t.includes("\n")) return "text";
  if (HAS_LINK.test(t) || HAS_MONEY_OR_NUMBER.test(t) || HAS_REQUISITES.test(t)) return "text";
  const limit = ctx.clientSentVoice ? MAX_AFTER_CLIENT_VOICE : MAX_WARM;
  return t.length <= limit ? "voice" : "text";
}

/** Пробует ответить голосом; true — ответ ушёл голосом, false — отвечать текстом как обычно. */
export async function trySendVoiceReply(
  contact: { id: string; igUserId: string; channel: string },
  text: string,
  clientSentVoice: boolean
): Promise<boolean> {
  try {
    if ((await getSetting("voiceReplyEnabled")) !== "true" || !(await voiceEnabled())) return false;
    const last = await prisma.message.findFirst({ where: { contactId: contact.id, direction: "OUT" }, orderBy: { createdAt: "desc" } });
    const choice = chooseVoiceOrText(text, {
      channel: contact.channel,
      clientSentVoice,
      lastReplyWasVoice: Boolean(last?.text?.startsWith(VOICE_MARK)),
    });
    if (choice !== "voice") return false;
    const { url } = await synthesizeToFile(text);
    const mid = await sendAttachmentToContact(contact, url, "audio");
    await recordOutgoingMessage(contact.id, `${VOICE_MARK}${text.trim()}`, mid);
    return true;
  } catch (err) {
    logError("voiceReply", err);
    return false;
  }
}
