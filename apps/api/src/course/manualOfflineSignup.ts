import { prisma, getSetting, logError } from "../db.js";
import { sendTelegramMessage } from "../telegram.js";
import { extractName, extractPhone, registerOfflineSignup } from "../ai/offlineSignup.js";

/**
 * ЗАПИСЬ НА ОФЛАЙН-КУРС ИЗ WHATSAPP — командой из Telegram (владелец 05.09.2026).
 *
 * У бота нет доступа к WhatsApp Ширин — она сама выдаёт номер для перевода и
 * сама получает записи от желающих на очный курс. Раньше такие записи никак
 * не попадали в нашу базу: сводка и панель их не видели, «Записались на
 * офлайн» в вечернем письме стояло 0, даже когда людей было много.
 *
 * Теперь: переслать сюда сообщение из WhatsApp (или просто написать имя и
 * номер) командой
 *
 *     /вотсап Мадина, 900 11 22 33
 *
 * — и запись ляжет в ту же таблицу OfflineSignup, что и записи из Instagram:
 * попадёт в сводку, в счётчик на дашборде, получит напоминание за сутки до
 * курса (offlineReminder.ts уже умеет слать ссылку wa.me, если окно Instagram
 * закрыто — а у WhatsApp-контакта оно закрыто всегда, входящих сообщений от
 * него в нашей базе нет).
 *
 * ДВЕРЬ ЗАКРЫТА НАГЛУХО — тот же принцип, что у manualLink.ts: команда
 * работает только из своих чатов школы (владелец/сводки), не задан ни один —
 * не работает ни для кого.
 */

/** По-русски, по-таджикски латиницей и по-английски — как набрать быстрее. */
const COMMANDS = ["/вотсап", "/ватсап", "/vatsap", "/whatsapp", "/wa", "/офлайн", "/oflayn"];

type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string };
  from?: { id?: number | string };
};

/** true — сообщение было командой и обработано; дальше его вести не нужно. */
export async function handleWhatsappSignupCommand(message: TgMessage): Promise<boolean> {
  const text = (message.text ?? "").trim();
  const lower = text.toLowerCase();
  const command = COMMANDS.find((c) => lower === c || lower.startsWith(`${c} `) || lower.startsWith(`${c}\n`));
  if (!command) return false;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const allowed = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter((v): v is string => Boolean(v));
  if (!botToken || allowed.length === 0) return false;

  const who = [message.chat?.id, message.from?.id].filter((v) => v != null).map(String);
  if (!who.some((id) => allowed.includes(id))) {
    // Молча, как в manualLink.ts: посторонний не должен даже узнать, что
    // такая команда существует.
    logError("course:manualOfflineSignup", new Error(`команду позвал посторонний чат ${who.join("/") || "?"}`));
    return true;
  }

  const replyTo = who.find((id) => allowed.includes(id)) ?? allowed[0];
  const reply = (body: string) => sendTelegramMessage(botToken, replyTo, body, message.message_id ?? undefined);
  const argument = text.slice(command.length).trim();

  if (!argument) {
    await reply(
      "Перешлите сюда сообщение из WhatsApp с именем и номером (или напишите сами) после команды:\n\n" +
        "/вотсап Мадина, 900 11 22 33\n\n" +
        "Запишу на офлайн-курс — попадёт в сводку и напоминание за сутки до начала."
    );
    return true;
  }

  const phone = extractPhone(argument);
  if (!phone) {
    await reply("Не нашла номер телефона в этом тексте. Нужны 9 цифр, например 900112233 — попробуйте ещё раз.");
    return true;
  }
  const name = extractName(argument) ?? "имя не указано";

  try {
    // WhatsApp-лид — отдельный канал контакта: телефон вместо igUserId,
    // детерминированный ключ (тот же номер второй раз не плодит дубль контакта).
    const contact = await prisma.contact.upsert({
      where: { channel_igUserId: { channel: "WHATSAPP", igUserId: `wa:${phone}` } },
      create: { channel: "WHATSAPP", igUserId: `wa:${phone}`, username: name !== "имя не указано" ? name : null },
      update: name !== "имя не указано" ? { username: name } : {},
    });

    // registerOfflineSignup() отвечает true и на новую запись, и на уже
    // существующую (идемпотентность) — для точного ответа Ширин смотрим сюда
    // ДО вызова, чтобы не сказать «записала» о том, кто уже был записан.
    const existed = Boolean(await prisma.offlineSignup.findUnique({ where: { contactId: contact.id } }));
    await registerOfflineSignup(contact, argument);
    await reply(
      existed
        ? `${name} — ${phone} — такая запись уже есть, второй раз не дублирую.`
        : `Записала: ${name} — ${phone}. Позвонить за день до курса — ссылка WhatsApp придёт вместе с напоминанием.`
    );
  } catch (err) {
    logError("course:manualOfflineSignup", err);
    await reply("Не получилось записать. Загляните в журнал ошибок в панели.");
  }
  return true;
}
