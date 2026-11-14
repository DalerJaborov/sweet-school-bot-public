import { cleanKeepingWarmTail } from "../ai/replyPolicy.js";
import { humanizeForContact } from "./humanize.js";
import crypto from "node:crypto";
import { prisma, WEB_MID_PREFIX, recordOutgoingMessage, logError } from "../db.js";
import { channelOf, sendText, sendAttachment, type QuickButton } from "../instagram.js";
import { stripRepeatGreeting } from "../greeting.js";
import { toOwnerVoice } from "../voice.js";
import {
  assertMessagingAllowed,
  withMessagingPermission,
  withContactMessaging,
  type MessagePurpose,
} from "./automation.js";
import { sendWhatsAppText, sendWhatsAppAttachment } from "../whatsapp/transport.js";

/**
 * ЕДИНАЯ ДВЕРЬ НАРУЖУ: «написать этому человеку», где бы он ни писал.
 *
 * До сайта исходящие шли напрямую в instagram.ts: пятнадцать мест по коду
 * знали про igUserId и channelOf(contact). С появлением чата на сайте у
 * контакта может не быть Meta вовсе — и чинить каждое из пятнадцати мест
 * отдельно значило бы забыть одно (скорее всего, самое редкое: возврат
 * доступа или напоминание), и человек с сайта не получил бы ссылку на курс.
 *
 * Поэтому маршрутизация по каналу живёт здесь и только здесь:
 *   INSTAGRAM / MESSENGER — как раньше, байт в байт: те же функции instagram.ts,
 *                           с тем же «прочитано → печатает → текст»;
 *   WEB                   — сети нет, «отправить» значит записать строку
 *                           Message(OUT); сайт заберёт её через /api/site/chat/poll.
 *
 * ДОГОВОР О ЗАПИСИ В БАЗУ. Весь существующий код после отправки сам кладёт
 * строку Message (recordOutgoingMessage или prisma.message.create) — трогать
 * этот порядок для Meta нельзя, там он защищает от гонки с эхом вебхука. Для
 * WEB строку кладём здесь и возвращаем mid с префиксом WEB_MID_PREFIX:
 * recordOutgoingMessage по нему понимает, что запись уже есть, и второй не
 * делает. Значит, у вызывающих остаётся одно правило: записывать через
 * recordOutgoingMessage, а не голым create.
 */

type Recipient = { id: string; igUserId: string; channel: string };

export type SendOptions = {
  /** Написала живая Ширин (кнопка в Telegram, панель), а не бот. На сайте такое
   *  сообщение показывается как «ответ владельца»; для Meta признак не нужен —
   *  там его ставит эхо вебхука по факту. */
  byHuman?: boolean;
  purpose?: "verified_receipt_access";
};

export async function sendToContact(
  contact: Recipient,
  text: string,
  buttons: QuickButton[] = [],
  opts: SendOptions = {},
): Promise<string | null> {
  if (!opts.byHuman) text = await humanizeForContact(contact.id, cleanKeepingWarmTail(text));
  // ОДНО ПРИВЕТСТВИЕ — И В ИСТОРИИ ТОЖЕ (11.11.2026). Срез повторного «Ассалому
  // алейкум» раньше жил только внутри sendText, а в историю ложился текст ДО среза:
  // разбор переписок видел «второе приветствие», которого клиент не получал, а
  // модель читала историю с лишними приветствиями и копировала их. Режем здесь,
  // до записи; sendText режет ещё раз — правка идемпотентна.
  if (!opts.byHuman) text = toOwnerVoice(await stripRepeatGreeting(contact.id, text).catch(() => text));
  // После фильтра ничего не осталось (ответ был одним обращением) — не шлём и не пишем.
  if (!text.trim()) return null;
  const purpose: MessagePurpose = opts.purpose ?? (opts.byHuman ? "human" : "reply");
  const shown = text;
  const mid = await withContactMessaging(contact.id, purpose, () =>
    opts.byHuman && !opts.purpose
      ? withMessagingPermission("human", () => sendContact(contact, shown, buttons, opts))
      : sendContact(contact, shown, buttons, opts),
  );
  // ИСТОРИЯ = ТО, ЧТО УШЛО (08.11.2026). Вызывающий код по старому договору пишет
  // recordOutgoingMessage(исходный текст, mid) — до фильтра. Пишем здесь первыми уже
  // отправленный текст: вторая запись с тем же mid ничего не меняет (P2002), а сравнения
  // по истории (шаблоны, видео, образцы манеры) видят ровно то, что видел клиент, во
  // всех каналах одинаково. Порядок «отправил → записал» для Meta тот же. Сообщения
  // Ширин пишет эхо вебхука, не мы. Сайт свою строку уже положил (WEB_MID_PREFIX).
  if (!opts.byHuman && mid) {
    await recordOutgoingMessage(contact.id, shown, mid).catch((err) => logError("send:recordShown", err));
  }
  return mid;
}

async function sendContact(
  contact: Recipient,
  text: string,
  buttons: QuickButton[],
  opts: SendOptions,
): Promise<string | null> {
  await assertMessagingAllowed();
  const channel = channelOf(contact);
  if (channel === "WHATSAPP")
    return sendWhatsAppText(contact, text, buttons, opts.purpose ?? (opts.byHuman ? "human" : "reply"));
  if (channel !== "WEB") return sendText(contact.igUserId, text, buttons, channel);

  // Правило «здороваемся один раз» и голос владелицы — те же, что у sendText:
  // человек на сайте не должен получать «Здравствуйте» в каждом пузыре.
  // Задержки «печатает…» нет нарочно: на сайте ответ и так ждут с спиннером,
  // а лишние секунды — это лишние секунды.
  const clean = toOwnerVoice(await stripRepeatGreeting(contact.id, text).catch(() => text));
  await assertMessagingAllowed();
  return persistWebOutgoing(contact.id, { text: clean, byHuman: opts.byHuman === true });
}

/** Картинка/видео/файл по ссылке. Для WEB — строка с imageUrl (картинка) или
 *  ссылкой текстом (остальное: сайт показывает её как обычную ссылку). */
export async function sendAttachmentToContact(
  contact: Recipient,
  url: string,
  type: "video" | "image" | "audio" | "file" = "image",
): Promise<string | null> {
  return withContactMessaging(contact.id, "reply", async () => {
    await assertMessagingAllowed();
    const channel = channelOf(contact);
    if (channel !== "WEB") {
      // WhatsApp — так же, как Instagram (ревью 11.11.2026): раньше вложение уходило
      // без строки в истории и без метки, mediaAlreadySent его не видел, и фото меню
      // уходило человеку в WhatsApp на каждый вопрос про курс.
      const mid =
        channel === "WHATSAPP"
          ? await sendWhatsAppAttachment(contact, url, type)
          : await sendAttachment(contact.igUserId, url, type, channel);
      // КРИТИЧНО: без записи mid эхо нашей же картинки (меню, фото воронки) вебхук
      // принимает за ответ хозяйки из приложения и ставит «передано человеку» —
      // бот замолкает для клиента навсегда (инцидент 08.11.2026, шаг воронки с
      // картинкой). recordOutgoingMessage ещё и чинит ложную пометку, если эхо
      // успело прийти раньше.
      if (mid) await recordOutgoingMessage(contact.id, "", mid).catch((err) => logError("send:recordAttachment", err));
      if (mid) await markSentMedia(mid, url);
      return mid;
    }
    const webMid =
      type === "image"
        ? await persistWebOutgoing(contact.id, { imageUrl: url })
        : await persistWebOutgoing(contact.id, { text: url });
    await markSentMedia(webMid, url);
    return webMid;
  });
}

/**
 * КАКОЕ ВЛОЖЕНИЕ УШЛО (11.11.2026, «не повторять уже отправленное»). Ссылка на
 * файл пишется меткой в payload нашей же строки истории — по ней меню, отзывы и
 * видео не уходят человеку второй раз, кто бы их ни послал (воронка, ИИ, отзывы).
 * Payload исходящих строк больше никто не читает (у входящих там кнопки).
 */
export const SENT_MEDIA_PREFIX = "media:";

async function markSentMedia(mid: string | null, url: string): Promise<void> {
  if (!mid) return;
  try {
    await prisma.message.updateMany({
      where: { mid, direction: "OUT" },
      data: { payload: (SENT_MEDIA_PREFIX + url).slice(0, 1000) },
    });
  } catch (err) {
    // Метка — только память «что уже уходило»; её сбой не ломает отправку.
    logError("send:markMedia", err);
  }
}

/** Уходил ли этот файл человеку раньше. Сбой базы — считаем «уходил»: лучше не повторить. */
export async function mediaAlreadySent(contactId: string, url: string): Promise<boolean> {
  try {
    const row = await prisma.message.findFirst({
      where: {
        contactId,
        direction: "OUT",
        OR: [{ payload: (SENT_MEDIA_PREFIX + url).slice(0, 1000) }, { imageUrl: url }],
      },
      select: { id: true },
    });
    return Boolean(row);
  } catch {
    return true;
  }
}

/** Видео с подписью ОДНИМ сообщением: WhatsApp-мост принимает caption вместе с файлом (одна отправка вместо двух
 *  — у моста лимит 8 за 10 минут на чат). В остальных каналах подписи у вложения нет — тогда текст, затем файл. */
export async function sendVideoWithCaption(contact: Recipient, url: string, caption: string): Promise<string | null> {
  if (channelOf(contact) === "WHATSAPP") {
    // Подпись — тот же текст бота, что и в sendToContact: через тот же фильтр, и в
    // историю ровно то, что ушло (вызывающий пишет исходник — запись с тем же mid не меняет).
    const shown = await humanizeForContact(contact.id, cleanKeepingWarmTail(caption));
    const mid = await withContactMessaging(contact.id, "reply", async () => {
      await assertMessagingAllowed();
      return sendWhatsAppAttachment(contact, url, "video", "reply", shown.trim() ? shown : undefined);
    });
    if (mid)
      await recordOutgoingMessage(contact.id, shown.trim() ? shown : "", mid).catch((err) =>
        logError("send:recordCaption", err),
      );
    await markSentMedia(mid, url);
    return mid;
  }
  // Подпись уходит отдельным текстом и сама пишется в историю (sendToContact); возвращаем
  // её mid, чтобы запись вызывающего не продублировала подпись на строке видео.
  const captionMid = await sendToContact(contact, caption);
  const videoMid = await sendAttachmentToContact(contact, url, "video");
  return captionMid ?? videoMid;
}

export function sendImageToContact(contact: Recipient, url: string): Promise<string | null> {
  return sendAttachmentToContact(contact, url, "image");
}

async function persistWebOutgoing(
  contactId: string,
  data: { text?: string; imageUrl?: string; byHuman?: boolean },
): Promise<string> {
  const mid = `${WEB_MID_PREFIX}${crypto.randomUUID()}`;
  await prisma.message.create({
    data: {
      contactId,
      direction: "OUT",
      mid,
      text: data.text ?? null,
      imageUrl: data.imageUrl ?? null,
      byHuman: data.byHuman ?? false,
    },
  });
  return mid;
}
