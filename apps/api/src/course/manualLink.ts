import { prisma, getSetting, logError } from "../db.js";
import { sendTelegramMessage } from "../telegram.js";
import { issueCourseLink } from "./delivery.js";

/**
 * ВЫДАТЬ ССЫЛКУ НА УРОКИ РУКАМИ — командой из Telegram.
 *
 * Обычно ссылка уходит сама: подтвердили чек — человек получил доступ. Но
 * живая школа не укладывается в один сценарий. Клиентка потеряла переписку,
 * сменила аккаунт, написала не туда, заплатила наличными на очном курсе, или
 * Ширин просто хочет открыть кому-то доступ в виде подарка. До сих пор в таких
 * случаях выхода не было вовсе — оставалось звать программиста.
 *
 * Теперь: написать боту в свой чат
 *
 *     /ссылка @username
 *
 * и получить свежую ссылку, которую можно переслать человеку самой.
 *
 * ДВЕРЬ ЗАКРЫТА НАГЛУХО. Команда работает только из СВОИХ чатов школы — тех,
 * что владелец сам вписал в настройки (чат владельца и чат сводок). Не задан
 * ни один — команда не работает ни для кого: иначе любой, кто найдёт бота, мог
 * бы попросить ссылку на чужие оплаченные уроки, назвав чужой ник.
 *
 * Чатов два намеренно. На проде 03.09.2026 «чат владельца» оказался не
 * заполнен вовсе, а живёт Ширин в чате сводок — привязка к одной настройке
 * означала бы команду, которой нельзя воспользоваться.
 *
 * Каждая выдача выпускает НОВУЮ ссылку, а прошлая перестаёт работать (см.
 * delivery.ts issueCourseLink). Так пересланная кому-то старая ссылка умирает
 * сама, без отдельного «отозвать».
 */

/** Как можно позвать команду: по-русски, по-английски и таджикской латиницей. */
const COMMANDS = ["/ссылка", "/link", "/havola", "/dostup", "/доступ"];

type TgMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string };
  from?: { id?: number | string };
};

/** true — сообщение было командой и обработано; дальше его вести не нужно. */
export async function handleManualLinkCommand(message: TgMessage): Promise<boolean> {
  const text = (message.text ?? "").trim();
  const lower = text.toLowerCase();
  const command = COMMANDS.find((c) => lower === c || lower.startsWith(`${c} `) || lower.startsWith(`${c}@`));
  if (!command) return false;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const allowed = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter((v): v is string => Boolean(v));
  if (!botToken || allowed.length === 0) return false;

  // Свой ли это чат. Сравниваем и чат, и отправителя: в личке они совпадают,
  // но если владелец однажды позовёт команду из своей группы, сработает второе.
  const who = [message.chat?.id, message.from?.id].filter((v) => v != null).map(String);
  if (!who.some((id) => allowed.includes(id))) {
    // Молча. Посторонний не должен даже узнать, что такая команда существует.
    logError("course:manualLink", new Error(`команду позвал посторонний чат ${who.join("/") || "?"}`));
    return true;
  }

  // Отвечаем В ТОТ ЖЕ чат, откуда позвали: ответ, ушедший в другое окно, легко
  // не заметить, а ссылка нужна человеку прямо сейчас.
  const replyTo = who.find((id) => allowed.includes(id)) ?? allowed[0];
  const argument = text.slice(command.length).trim().replace(/^@/, "");
  const reply = (body: string) => sendTelegramMessage(botToken, replyTo, body, message.message_id ?? undefined);

  if (!argument) {
    await reply(
      "Кому выдать ссылку на уроки?\n\nНапишите так:\n/ссылка @username\n\n" +
        "Ник берите из переписки в Instagram. Ссылка будет новой, старая перестанет работать."
    );
    return true;
  }

  try {
    await answer(argument, reply);
  } catch (err) {
    logError("course:manualLink", err);
    await reply("Не получилось выдать ссылку. Загляните в журнал ошибок в панели.");
  }
  return true;
}

async function answer(argument: string, reply: (body: string) => Promise<unknown>): Promise<void> {
  // Ищем и по нику, и по внутреннему id: во второй руке остаётся способ найти
  // человека, у которого ника нет вовсе (в Instagram это бывает).
  const contacts = await prisma.contact.findMany({
    where: { OR: [{ username: { contains: argument } }, { igUserId: argument }] },
    select: { id: true, username: true, igUserId: true, studentFirstName: true, studentLastName: true },
    take: 6,
  });

  if (contacts.length === 0) {
    await reply(`Не нашла никого по «${argument}».\n\nПроверьте ник — он пишется без значка @, как в переписке.`);
    return;
  }

  if (contacts.length > 1) {
    // Выбрать за неё нельзя: выдать доступ не тому человеку — это отданные
    // деньги. Показываем найденных и просим уточнить.
    const list = contacts
      .slice(0, 5)
      .map((c) => `• ${c.username ? `@${c.username}` : c.igUserId}`)
      .join("\n");
    await reply(`Под «${argument}» подходят несколько:\n\n${list}\n\nНапишите ник целиком.`);
    return;
  }

  const contact = contacts[0];
  const who = contact.username ? `@${contact.username}` : contact.igUserId;
  const name = [contact.studentFirstName, contact.studentLastName].filter(Boolean).join(" ");

  // Только ДЕЙСТВУЮЩИЕ покупки: отозванная не должна оживать по команде,
  // иначе «отобрать доступ» превращается в кнопку без последствий.
  const purchases = await prisma.purchase.findMany({
    where: { contactId: contact.id, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, course: true },
  });

  if (purchases.length === 0) {
    const revoked = await prisma.purchase.count({ where: { contactId: contact.id, revokedAt: { not: null } } });
    await reply(
      revoked > 0
        ? `У ${who} доступ был отобран. Чтобы вернуть, откройте «Клиенты» в панели — там же видно, за что.`
        : `У ${who} нет оплаченного курса. Ссылку выдавать не за что.`
    );
    return;
  }

  // Ссылка одна на человека: внутри все его курсы.
  const url = await issueCourseLink(contact.id, { automatic: false });
  if (!url) {
    await reply("Адрес платформы не задан в настройках — ссылку собрать не из чего.");
    return;
  }

  const courses = purchases.map((p) => p.course).join(", ");
  await reply(
    `Ссылка для ${who}${name ? ` (${name})` : ""}\nКурсы: ${courses}\n\n${url}\n\n` +
      "Перешлите её человеку. Прошлая ссылка с этой минуты не работает."
  );
}
