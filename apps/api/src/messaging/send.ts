import crypto from "node:crypto";
import { prisma, WEB_MID_PREFIX } from "../db.js";
import { channelOf, sendText, sendAttachment, type QuickButton } from "../instagram.js";
import { stripRepeatGreeting } from "../greeting.js";
import { toOwnerVoice } from "../voice.js";

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
};

export async function sendToContact(
  contact: Recipient,
  text: string,
  buttons: QuickButton[] = [],
  opts: SendOptions = {}
): Promise<string | null> {
  const channel = channelOf(contact);
  if (channel !== "WEB") return sendText(contact.igUserId, text, buttons, channel);

  // Правило «здороваемся один раз» и голос владелицы — те же, что у sendText:
  // человек на сайте не должен получать «Здравствуйте» в каждом пузыре.
  // Задержки «печатает…» нет нарочно: на сайте ответ и так ждут с спиннером,
  // а лишние секунды — это лишние секунды.
  const clean = toOwnerVoice(await stripRepeatGreeting(contact.id, text).catch(() => text));
  return persistWebOutgoing(contact.id, { text: clean, byHuman: opts.byHuman === true });
}

/** Картинка/видео/файл по ссылке. Для WEB — строка с imageUrl (картинка) или
 *  ссылкой текстом (остальное: сайт показывает её как обычную ссылку). */
export async function sendAttachmentToContact(
  contact: Recipient,
  url: string,
  type: "video" | "image" | "audio" | "file" = "image"
): Promise<string | null> {
  const channel = channelOf(contact);
  if (channel !== "WEB") return sendAttachment(contact.igUserId, url, type, channel);
  return type === "image"
    ? persistWebOutgoing(contact.id, { imageUrl: url })
    : persistWebOutgoing(contact.id, { text: url });
}

export function sendImageToContact(contact: Recipient, url: string): Promise<string | null> {
  return sendAttachmentToContact(contact, url, "image");
}

async function persistWebOutgoing(
  contactId: string,
  data: { text?: string; imageUrl?: string; byHuman?: boolean }
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
