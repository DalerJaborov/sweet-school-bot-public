import { prisma, logError, recordOutgoingMessage } from "../db.js";
import { MetaDeliveryError } from "../messaging/metaErrors.js";
import { sendAttachmentToContact } from "../messaging/send.js";
import { decorateForV3, splitForVoice, synthesizeToFile, voiceEnabled } from "./voiceClone.js";
import { voiceRepliesAllowed } from "./voiceSwitch.js";

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
 *  - На короткое «спасибо / рахмат / хоб / ок» без вопроса голосом не отвечаем никогда:
 *    промт велит молчать или одно сердечко, а три голосовых на «рахмат» (Instagram
 *    08.11.2026) выглядят как автомат.
 *  - WhatsApp, Instagram и Messenger (мост и Graph шлют настоящее голосовое). Сайт — текстом.
 *  - Любая ошибка озвучки (потолок трат, сеть) — молча отвечаем текстом.
 */
/** Каналы, где голос разрешён, и формат файла: WhatsApp - ogg/opus, Instagram и Messenger - aac. Сайт (WEB) - только текст. */
const VOICE_FORMAT_BY_CHANNEL: Record<string, "ogg" | "aac" | undefined> = {
  WHATSAPP: "ogg",
  INSTAGRAM: "aac",
  MESSENGER: "aac",
};
export const VOICE_MARK = "🎤 ";
/** Короткая благодарность или «понял» без вопроса: голосом на такое не отвечаем. */
const ACK_WORD =
  "(?:спасибо|спс|благодарю|рахмати|раҳмати|рахмат|раҳмат|rahmat|raxmat|pahmat|pa[xh]mat|ташаккури|ташаккур|tashakkur|зиёд|ziyod|хоп|хоб|хуб|xob|xop|hop|hob|xub|майли|mayli|ok|ок|окей|okey|хорошо|ладно|понял|поняла|фахмидам|fahmidam|да|ҳа|ха|ha|yes|ясно|ага|большое|калон|апачон|апа|apajon|apa|ширин|shirin)";
const ACK_TEXT = new RegExp(`^${ACK_WORD}(?:[\\s,.!]+${ACK_WORD})*[\\s.!,)]*$`, "iu");
export function isShortAcknowledgement(clientText: string | null | undefined): boolean {
  // ❤️ — это два символа: сердце и невидимый селектор U+FE0F; 👩‍🍳 — с «клеем» U+200D.
  // Без них «Спасибо ❤️» не узнавалось, и на благодарность снова уходило голосовое.
  const t = (clientText ?? "").replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]/gu, "").trim();
  if (!t || t.length > 40 || t.includes("?")) return false;
  return ACK_TEXT.test(t);
}
const MAX_WARM = 260;
const MAX_AFTER_CLIENT_VOICE = 340;

// Голос разрешаем, только если НЕТ ничего похожего на адрес, число или деньги (ревью 08.11.2026:
// прежние узкие шаблоны пропускали t.me/..., «пять тысяч», таджикское «ҳазор»).
const HAS_LINK = /https?:|www\.|[\p{L}\d]\.[\p{L}]{2,}|@\w|\//u;
const HAS_DIGIT = /\d|[٠-٩]/u;
const HAS_MONEY_WORDS =
  /тысяч|сотн|\bсто\b|двест|тристо|миллион|сомон|рубл|доллар|₽|\$|цен[аыуе]|стоим|стоит|скидк|процент|тахфиф|оплат|платёж|платеж|платит|предоплат|перевод|перевест|карт[аыуеой]|реквизит|\bсч[её]т|нарх|нарҳ|ҳазор|\bсад\b|пардохт|корт|ҳисоб|гузарон|\bпул\b|usd|tjs/iu;

/** Текст для озвучки: без эмодзи и переносов строк. */
export function speakable(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function chooseVoiceOrText(
  text: string,
  ctx: { channel: string; clientSentVoice: boolean; lastReplyWasVoice: boolean },
): "voice" | "text" {
  if (!VOICE_FORMAT_BY_CHANNEL[ctx.channel] || ctx.lastReplyWasVoice) return "text";
  // Переносы строк и эмодзи для голоса не помеха: склеиваем в одну фразу (эмодзи озвучка не читает).
  const t = speakable(text);
  if (!t) return "text";
  if (HAS_LINK.test(t) || HAS_DIGIT.test(t) || HAS_MONEY_WORDS.test(t)) return "text";
  const limit = ctx.clientSentVoice ? MAX_AFTER_CLIENT_VOICE : MAX_WARM;
  return t.length <= limit ? "voice" : "text";
}

type VoiceCtx = { channel: string; clientSentVoice: boolean; lastReplyWasVoice: boolean };

/**
 * Что сказать голосом и что оставить текстом. Если весь ответ подходит под правило - всё голосом.
 * Если клиент САМ прислал голосовое, а в ответе есть цифры/деньги/ссылки - голосом уходят предложения без них,
 * а предложения с цифрами остаются текстом (владелец 08.11.2026: «три раза отправил голосовое, а он отвечает текстом»).
 */
export function planVoice(text: string, ctx: VoiceCtx): { voice: string; rest: string } | null {
  if (chooseVoiceOrText(text, ctx) === "voice") return { voice: speakable(text), rest: "" };
  if (!ctx.clientSentVoice || !VOICE_FORMAT_BY_CHANNEL[ctx.channel] || ctx.lastReplyWasVoice) return null;
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  const free: VoiceCtx = { ...ctx, lastReplyWasVoice: false };
  const voiced: string[] = [];
  const rest: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    const ok = chooseVoiceOrText(sentence, free) === "voice";
    if (ok && length + sentence.length + 1 <= MAX_AFTER_CLIENT_VOICE) {
      voiced.push(sentence);
      length += sentence.length + 1;
    } else rest.push(sentence);
  }
  const voice = speakable(voiced.join(" "));
  if (voice.length < 12) return null;
  return { voice, rest: rest.join("\n") };
}

/**
 * Был ли последний ответ бота голосовым. Смотрим последние исходящие, пропуская пустые строки:
 * в Instagram/Messenger каждое вложение записано пустой строкой (messaging/send.ts), метка
 * голосового дописывается в неё позже (db.ts), а у голосового из нескольких кусков помечен
 * только последний. Поэтому пустые строки сами по себе «не текст», решает первая непустая.
 */
export async function lastReplyWasVoice(contactId: string): Promise<boolean> {
  const recent = await prisma.message.findMany({
    where: { contactId, direction: "OUT" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { text: true },
  });
  const last = recent.find((m) => m.text?.trim());
  return Boolean(last?.text?.startsWith(VOICE_MARK));
}

/**
 * Пробует ответить голосом. null - голосом ничего не ушло, отправляйте весь ответ текстом.
 * Строка - остаток, который надо отправить текстом (пустая строка - весь ответ ушёл голосом).
 */
export async function trySendVoiceReply(
  contact: { id: string; igUserId: string; channel: string },
  text: string,
  clientSentVoice: boolean,
  clientText?: string | null,
): Promise<string | null> {
  let urls: string[];
  let plan: { voice: string; rest: string };
  try {
    if (isShortAcknowledgement(clientText)) return null;
    if (!(await voiceRepliesAllowed()) || !(await voiceEnabled())) return null;
    const planned = planVoice(text, {
      channel: contact.channel,
      clientSentVoice,
      lastReplyWasVoice: await lastReplyWasVoice(contact.id),
    });
    if (!planned) return null;
    plan = planned;
    const chunks = splitForVoice(plan.voice);
    if (!chunks) return null;
    // Куски озвучиваются параллельно (у каждого свой кеш), но уходят строго по очереди.
    urls = (
      await Promise.all(
        chunks.map((chunk, i) =>
          synthesizeToFile(decorateForV3(chunk, i, chunks.length), VOICE_FORMAT_BY_CHANNEL[contact.channel] ?? "ogg"),
        ),
      )
    ).map((r) => r.url);
  } catch (err) {
    // До отправки ничего не ушло - безопасно ответить текстом.
    logError("voiceReply", err);
    return null;
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
    // Meta чётко отказала в аудио ещё до первой отправки (например формат не принят): ничего не ушло, отвечаем текстом.
    if (sent === 0 && err instanceof MetaDeliveryError && err.kind !== "AMBIGUOUS" && err.status === 400) {
      logError("voiceReply:metaRejected", err);
      return null;
    }
    // Часть голосовых уже у клиента: запоминаем, что ушло, чтобы история и панель не считали, что бот молчал.
    if (sent > 0) {
      await recordOutgoingMessage(contact.id, `${VOICE_MARK}(ушло ${sent} из ${urls.length}) ${plan.voice}`, mid).catch(
        (e) => logError("voiceReply:record", e),
      );
    }
    throw err;
  }
  await recordOutgoingMessage(contact.id, `${VOICE_MARK}${plan.voice}`, mid);
  return plan.rest;
}
