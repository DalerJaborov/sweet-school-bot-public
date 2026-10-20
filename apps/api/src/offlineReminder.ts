import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { sendToContact } from "./messaging/send.js";
import { ownerAlertChatIds, sendTelegramMessage } from "./telegram.js";
import { offsetMs } from "./dailyReport.js";
import { detectClientLanguage } from "./ai/clientLanguage.js";
import { offlineStartDate } from "./ai/courseDate.js";

/**
 * НАПОМИНАНИЕ ЗА ДЕНЬ ДО ОЧНОГО КУРСА.
 *
 * Предоплаты у офлайна нет: человек называет имя и номер, а платит на первом
 * занятии. Значит единственное, что держит запись, — это память. За неделю
 * между «запишите меня» и началом курса половина забывает, и группа приходит
 * неполной, хотя мест не было.
 *
 * ЧЕСТНО ПРО WHATSAPP И SMS. Отправлять напрямую мы не можем: WhatsApp
 * Business API требует верификации бизнеса, SMS в Таджикистане — договора с
 * оператором и стоит в разы дороже. Поэтому напоминание идёт тремя путями,
 * которые уже есть и стоят ноль:
 *
 *  1. КЛИЕНТКЕ в Instagram — туда, где она и записывалась. Работает, если
 *     она писала нам в последние сутки (правило Meta), иначе молча пропускаем.
 *  2. ВЛАДЕЛИЦЕ в Telegram — список с готовой ССЫЛКОЙ wa.me на каждого:
 *     нажатие открывает WhatsApp с этим человеком и уже набранным текстом.
 *     Тридцать нажатий вместо тридцати звонков, и сообщение уходит с её
 *     личного номера — перед очным курсом это доверия добавляет, а не убавляет.
 *  3. Голос и звонок — там же, если она захочет сказать своими словами.
 *
 * Когда WhatsApp Business подключат, автоматическая отправка добавится здесь
 * же, без переделки остального.
 */

/** За сколько часов до начала напоминаем. 24 — накануне вечером человек ещё
 *  успевает переставить планы, а утром в день курса уже поздно. */
const HOURS_BEFORE = 24;
/** Окно, в которое считаем «пора»: тик идёт раз в 10 секунд, но одного часа
 *  достаточно, чтобы не зависеть от точности запуска. */
const WINDOW_HOURS = 6;

const TEXTS = {
  ru: (name: string) =>
    `${name ? `${name}, ` : ""}Завтра начинается наш курс 🌸\n\n` +
    `⏰ Ждём вас к 13:40\n` +
    `📍 Душанбе, Воданасос, здание Dodo Pizza\n\n` +
    `Продукты приносить не нужно, всё наше. До встречи!`,
  tg: (name: string) =>
    `${name ? `${name}, ` : ""}Пагоҳ курси мо оғоз мешавад 🌸\n\n` +
    `⏰ Соати 13:40 интизоратонем\n` +
    `📍 Душанбе, Воданасос, бинои Dodo Pizza\n\n` +
    `Маҳсулот овардан лозим нест, ҳама аз мо. То дидор!`,
};

/**
 * Дата начала курса в настройках — строго ГГГГ-ММ-ДД.
 *
 * Отдельно от текста карточки («3 октября»): разбирать дату из человеческой
 * фразы значит однажды ошибиться на месяц и не напомнить вовсе, а тихая
 * ошибка здесь стоит владелице неполной группы. Пусто или мусор — напоминание
 * просто не работает, и это видно в логе.
 */
async function courseStartAt(): Promise<Date | null> {
  const date = await offlineStartDate();
  if (!date) return null;
  // Занятия начинаются в 13:40 по Душанбе; переводим в момент времени сервера.
  const offset = await offsetMs();
  const midnightUtc = Date.UTC(date.year, date.month - 1, date.day);
  return new Date(midnightUtc - offset + 13 * 3_600_000 + 40 * 60_000);
}


export async function runOfflineReminders(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("offlineReminder", sweep);
}

async function sweep(): Promise<void> {
  const startAt = await courseStartAt();
  if (!startAt) return;

  const hoursLeft = (startAt.getTime() - Date.now()) / 3_600_000;
  // Окно «сутки до начала»: раньше — рано, позже — курс уже идёт.
  if (hoursLeft > HOURS_BEFORE || hoursLeft < HOURS_BEFORE - WINDOW_HOURS) return;

  // Напоминаем только тем, кто записался на ЭТОТ набор: запись старше даты
  // начала относится к прошлому курсу.
  const signups = await prisma.offlineSignup.findMany({
    where: { reminderSentAt: null, createdAt: { lt: startAt } },
    include: { contact: true },
    take: 100,
  });
  if (signups.length === 0) return;

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const ownerChat = (await ownerAlertChatIds())[0];
  const forOwner: string[] = [];
  let reachedInInstagram = 0;

  for (const signup of signups) {
    // Отметку ставим ПЕРВОЙ: напоминание обещано одно, и лучше пропустить его
    // при сбое, чем прислать дважды.
    await prisma.offlineSignup.update({ where: { id: signup.id }, data: { reminderSentAt: new Date() } });

    // Пишем клиентке, только если окно Meta открыто — иначе Instagram молча
    // отклонит, а мы решим, что напомнили.
    const lastIn = await prisma.message.findFirst({
      where: { contactId: signup.contactId, direction: "IN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, text: true },
    });
    const windowOpen = lastIn != null && Date.now() - lastIn.createdAt.getTime() < 24 * 3_600_000;

    if (windowOpen) {
      const language = detectClientLanguage(lastIn?.text ?? "");
      const text = (language === "tg" ? TEXTS.tg : TEXTS.ru)(signup.name);
      try {
        const mid = await sendToContact(signup.contact, text);
        await recordOutgoingMessage(signup.contactId, text, mid);
        reachedInInstagram += 1;
      } catch (err) {
        logError("offlineReminder:send", err);
      }
    }

    const who = signup.contact.username ? `@${signup.contact.username}` : signup.contact.igUserId;
    // ССЫЛКА WA.ME С УЖЕ НАБРАННЫМ ТЕКСТОМ. Раньше здесь был голый номер, и
    // владелице оставалось обзвонить тридцать человек — полтора часа накануне
    // вечером, когда она уже устала. Теперь одно нажатие открывает WhatsApp с
    // этим человеком и готовым сообщением: тридцать нажатий вместо тридцати
    // звонков. Никакого платного шлюза для этого не нужно, и сообщение уходит
    // с её личного номера — для очного курса это плюс, а не минус.
    const waText = encodeURIComponent(TEXTS.ru(signup.name));
    const waLink = `https://wa.me/992${signup.phone}?text=${waText}`;
    forOwner.push(
      [
        `${signup.name || "имя не указано"} — ${signup.phone}${windowOpen ? "" : " ← бот не смог написать"}`,
        who,
        waLink,
      ].join("\n")
    );
  }

  if (botToken && ownerChat && forOwner.length > 0) {
    await sendTelegramMessage(
      botToken,
      ownerChat,
      `📣 Завтра начинается очный курс. Записалось: ${forOwner.length}\n` +
        `Боту удалось написать в Instagram: ${reachedInInstagram}\n\n` +
        `${forOwner.join("\n")}\n\n` +
        `Нажмите на ссылку под нужным человеком — откроется WhatsApp с уже написанным сообщением.`
    ).catch((err) => logError("offlineReminder:notifyOwner", err));
  }

  logInfo("offlineReminder", `напомнили ${forOwner.length}, из них в Instagram ${reachedInInstagram}`);
}
