import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { sendAttachmentToContact } from "../messaging/send.js";
import { splitForVoice, synthesizeToFile, voiceEnabled } from "./voiceClone.js";

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

// Голос разрешаем, только если НЕТ ничего похожего на адрес, число или деньги (ревью 08.11.2026:
// прежние узкие шаблоны пропускали t.me/..., «пять тысяч», таджикское «ҳазор»).
const HAS_LINK = /https?:|www\.|[\p{L}\d]\.[\p{L}]{2,}|@\w|\//u;
const HAS_DIGIT = /\d|[٠-٩]/u;
const HAS_MONEY_WORDS =
  /тысяч|сотн|\bсто\b|двест|тристо|миллион|сомон|рубл|доллар|₽|\$|цен[аыуе]|стоим|стоит|скидк|процент|тахфиф|оплат|платёж|платеж|платит|предоплат|перевод|перевест|карт[аыуеой]|реквизит|\bсч[её]т|нарх|нарҳ|ҳазор|\bсад\b|пардохт|корт|ҳисоб|гузарон|\bпул\b|usd|tjs/iu;

export function chooseVoiceOrText(
  text: string,
  ctx: { channel: string; clientSentVoice: boolean; lastReplyWasVoice: boolean },
): "voice" | "text" {
  if (ctx.channel !== "WHATSAPP" || ctx.lastReplyWasVoice) return "text";
  const t = text.trim();
  if (!t || t.includes("\n")) return "text";
  if (HAS_LINK.test(t) || HAS_DIGIT.test(t) || HAS_MONEY_WORDS.test(t)) return "text";
  const limit = ctx.clientSentVoice ? MAX_AFTER_CLIENT_VOICE : MAX_WARM;
  return t.length <= limit ? "voice" : "text";
}

/** Пробует ответить голосом; true — ответ ушёл голосом, false — отвечать текстом как обычно. */
export async function trySendVoiceReply(
  contact: { id: string; igUserId: string; channel: string },
  text: string,
  clientSentVoice: boolean,
): Promise<boolean> {
  let urls: string[];
  try {
    if ((await getSetting("voiceReplyEnabled")) !== "true" || !(await voiceEnabled())) return false;
    const last = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "OUT" },
      orderBy: { createdAt: "desc" },
    });
    const choice = chooseVoiceOrText(text, {
      channel: contact.channel,
      clientSentVoice,
      lastReplyWasVoice: Boolean(last?.text?.startsWith(VOICE_MARK)),
    });
    if (choice !== "voice") return false;
    const chunks = splitForVoice(text);
    if (!chunks) return false;
    // Куски озвучиваются параллельно (у каждого свой кеш), но уходят строго по очереди.
    urls = (await Promise.all(chunks.map((chunk) => synthesizeToFile(chunk)))).map((r) => r.url);
  } catch (err) {
    // До отправки ничего не ушло - безопасно ответить текстом.
    logError("voiceReply", err);
    return false;
  }
  // После вызова моста исход мог остаться неизвестным: текстом НЕ дублируем,
  // ошибку отдаём вызывающему (мост запрещает автоповтор при неопределённом исходе).
  // Паузы между кусками (4-9 с) держит мост: это его антибан-темп, он же показывает «записывает аудио».
  let mid: string | null = null;
  let sent = 0;
  try {
    for (const url of urls) {
      mid = await sendAttachmentToContact(contact, url, "audio");
      sent += 1;
    }
  } catch (err) {
    // Часть голосовых уже у клиента: запоминаем, что ушло, чтобы история и панель не считали, что бот молчал.
    if (sent > 0) {
      await recordOutgoingMessage(contact.id, `${VOICE_MARK}(ушло ${sent} из ${urls.length}) ${text.trim()}`, mid).catch((e) => logError("voiceReply:record", e));
    }
    throw err;
  }
  await recordOutgoingMessage(contact.id, `${VOICE_MARK}${text.trim()}`, mid);
  return true;
}
