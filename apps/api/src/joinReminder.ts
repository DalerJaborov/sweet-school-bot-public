import { prisma, getSetting, logError, recordOutgoingMessage } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { sendToContact } from "./messaging/send.js";
import { ownerAlertChatIds, sendTelegramMessage, createOneTimeInviteLink } from "./telegram.js";
import { rememberInviteLink } from "./groupAccess.js";
import { chatIdFor, COURSE_TITLE, type Course } from "./courses.js";
import { deliveryMode, deliveryModeFor, issueCourseLink, type DeliveryMode } from "./course/delivery.js";

/**
 * «Заплатил, но в группу не зашёл».
 *
 * Часть учениц просто не понимает, что делать со ссылкой: Telegram у них либо не
 * установлен, либо ссылка открылась не в том приложении. Деньги отданы, уроков
 * человек не видит — и молчит, потому что стесняется. Через 20 часов бот
 * напоминает ОДИН раз (решение владельца: один раз, не больше) и заодно
 * сообщает сестре — дальше уже живой человек доведёт за руку.
 *
 * Решение владельца (25.08.2026 веч.): не только ПРОСИТЬ написать за новой
 * ссылкой, а перевыпустить и прислать её самому, не дожидаясь просьбы клиента —
 * старая могла быть непонятна/потеряна, а лишний шаг «напишите нам» теряет
 * стеснительных людей так же, как и сама проблема со ссылкой.
 */

const AFTER_HOURS = 20;
/** Meta пускает нас писать первым только 24 часа после сообщения человека.
 *  Напоминание в 20 часов укладывается, но проверяем окно по последнему
 *  входящему: если он написал раньше, писать уже нельзя. */
const META_WINDOW_HOURS = 24;

/** Ссылка перевыпущена и уже в тексте — просим просто нажать. Если перевыпустить
 *  не удалось (нет токена/chatId), запасной вариант без ссылки — как раньше. */
const TEXT_TG_WITH_LINK =
  "Дидам ки ҳанӯз ба гурӯҳ надаромадед 🌸 Мана линки нав, пахш кунед ва «Присоединиться»:\n";
const TEXT_RU_WITH_LINK =
  "Вижу, что вы ещё не зашли в группу 🌸 Вот новая ссылка, нажмите и «Присоединиться»:\n";
const TEXT_TG_NO_LINK =
  "Дидам ки ҳанӯз ба гурӯҳ надаромадед 🌸 Линкро пахш кунед ва «Присоединиться» — " +
  "агар кор накунад, нависед, ман линки навро мефиристам";
const TEXT_RU_NO_LINK =
  "Вижу, что вы ещё не зашли в группу 🌸 Нажмите на ссылку и «Присоединиться» — " +
  "если не открывается, напишите, пришлю новую";
/** Веб-режим: группы нет вовсе, человек просто не открыл свои уроки. */
const TEXT_TG_WEB =
  "Дидам ки ҳанӯз дарсҳоятонро накушодед 🌸 Мана линк, аз телефон пахш кунед:\n";
const TEXT_RU_WEB = "Вижу, что вы ещё не открыли свои уроки 🌸 Вот ссылка, откройте с телефона:\n";

/** Перевыпускает ссылку на каждый неотозванный купленный курс, куда человек ещё
 *  не вошёл — старую он мог потерять/не понять. Возвращает готовые строки для
 *  сообщения клиенту ("Название\nссылка" на каждый курс) — пусто, если выпустить
 *  ничего не вышло (нет токена бота или chatId группы не настроен). */
async function reissueLinks(contactId: string, botToken: string | undefined, mode: DeliveryMode): Promise<string[]> {
  // Режим доставки решает, КУДА зовём: в привычную группу, на платформу или
  // и туда, и туда (см. course/delivery.ts). В веб-режиме токен бота не нужен
  // вовсе — раньше без него функция сразу возвращала пустой список.
  // Режим передаёт вызывающий: он зависит от человека (с сайта — всегда платформа).
  const wantTelegram = mode === "telegram" || mode === "both";
  const wantWeb = mode === "web" || mode === "both";
  if (wantTelegram && !botToken && !wantWeb) return [];

  const purchases = await prisma.purchase.findMany({ where: { contactId, revokedAt: null, joinedAt: null } });
  if (purchases.length === 0) return [];
  // Ссылку на платформу перевыпускаем всегда заново: прошлая гаснет, и
  // пересланная кому-то старая перестаёт работать. Одна на человека — окно
  // одно на все курсы, и одной строки в напоминании достаточно.
  const sharedWebLink = wantWeb ? await issueCourseLink(contactId) : null;
  if (wantWeb && !wantTelegram) return sharedWebLink ? [sharedWebLink] : [];

  const lines: string[] = [];
  for (const purchase of purchases) {
    const course = purchase.course as Course;
    const webLink = sharedWebLink;
    const chatId = wantTelegram && botToken ? await chatIdFor(course) : null;
    const tgLink = chatId && botToken ? await createOneTimeInviteLink(botToken, chatId) : null;

    if (webLink && !tgLink) {
      lines.push(purchases.length > 1 ? `${COURSE_TITLE[course]}\n${webLink}` : webLink);
      continue;
    }
    const link = tgLink;
    if (!link) continue;
    if (webLink) lines.push(webLink);
    await prisma.purchase.update({ where: { id: purchase.id }, data: { inviteLink: link } });
    await rememberInviteLink(contactId, link).catch((err) => {
      logError("joinReminder:rememberInviteLink", err);
    });
    lines.push(purchases.length > 1 ? `${COURSE_TITLE[course]}\n${link}` : link);
  }
  return lines;
}


export async function runJoinReminders(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  // 30 мин: двойной прогон = двойное напоминание клиентке (см. receiptRetry).
  await singleFlight("joinReminder", sweep, 30 * 60_000);
}

async function sweep(): Promise<void> {
  const since = new Date(Date.now() - AFTER_HOURS * 3_600_000);
  const mode = await deliveryMode();
  const waiting = await prisma.contact.findMany({
    where: {
      paid: true,
      paidAt: { lte: since },
      // В режиме telegram признак «не дошла» — не вошла в группу. Как только
      // курс выдаётся ссылкой на платформу, этого поля не будет НИКОГДА, и
      // условие превратилось бы в «напомнить вообще всем»; там признак
      // другой — ни одна покупка не открыта (проверяется ниже, purchases).
      ...(mode === "telegram" ? { joinedGroupAt: null } : {}),
      joinReminderAt: null,
      accessRevokedAt: null,
      personal: false,
      ...(mode === "telegram"
        ? {}
        : { purchases: { some: { revokedAt: null, firstOpenedAt: null } } }),
    },
    take: 20,
  });
  if (waiting.length === 0) return;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const sisterChat = (await ownerAlertChatIds())[0];

  for (const contact of waiting) {
    // Отметку ставим ПЕРВОЙ: напоминание обещано одно, и лучше пропустить его
    // при сбое, чем послать дважды.
    await prisma.contact.update({ where: { id: contact.id }, data: { joinReminderAt: new Date() } });

    const lastIn = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "IN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, text: true },
    });
    const windowOpen =
      lastIn != null && (Date.now() - lastIn.createdAt.getTime()) / 3_600_000 < META_WINDOW_HOURS;

    // Пришедшая с сайта получает платформу при любом режиме (deliveryModeFor).
    const contactMode = await deliveryModeFor(contact);
    const links = await reissueLinks(contact.id, botToken, contactMode);

    if (windowOpen) {
      // Язык берём по последнему сообщению человека — писать по-русски той, кто
      // писала на таджикском, значит сразу выдать в себе робота.
      const tajik = /[ҳҷқғӯӣ]|шумо|апа|курс(и|ро)/i.test(lastIn?.text ?? "");
      // В веб-режиме зовём открыть уроки, а не «войти в группу»: группы у
      // такой ученицы нет, и просьба присоединиться к ней сбивала бы с толку.
      const webOnly = contactMode === "web";
      const text =
        links.length > 0
          ? (webOnly
              ? tajik
                ? TEXT_TG_WEB
                : TEXT_RU_WEB
              : tajik
                ? TEXT_TG_WITH_LINK
                : TEXT_RU_WITH_LINK) + links.join("\n\n")
          : tajik
            ? TEXT_TG_NO_LINK
            : TEXT_RU_NO_LINK;
      try {
        const mid = await sendToContact(contact, text);
        await recordOutgoingMessage(contact.id, text, mid);
      } catch (err) {
        logError("joinReminder:send", err);
      }
    }

    // Сестре сообщаем в любом случае — даже когда окно Meta закрыто и написать
    // человеку нельзя. Тогда это единственный способ его не потерять.
    if (botToken && sisterChat) {
      const who = contact.username ? `@${contact.username}` : contact.igUserId;
      const linkNote = links.length > 0 ? " Ссылка перевыпущена." : "";
      const note = windowOpen
        ? `бот напомнил.${linkNote}`
        : `написать боту уже нельзя — окно Instagram закрыто.${linkNote}`;
      const where = mode === "web" ? "не открыл(а) уроки" : "не зашёл(шла) в группу";
      await sendTelegramMessage(
        botToken,
        sisterChat,
        `📌 ${who} оплатил(а), но за ${AFTER_HOURS} часов ${where}\n${note}`
      ).catch((err) => logError("joinReminder:notify", err));
    }
  }
}
