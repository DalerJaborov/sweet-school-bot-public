import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { sendToContact } from "./messaging/send.js";
import { everTalkedWithShirin } from "./messaging/automation.js";
import { techChatIds, sendTelegramMessage } from "./telegram.js";
import { offsetMs } from "./dailyReport.js";
import { contactLanguage } from "./ai/contactLanguage.js";
import { offlineStartDate } from "./ai/courseDate.js";
import { offlineAddress, parseHours, type OfflineFacts } from "./ai/offlineFacts.js";
import { getOfflineFacts } from "./services/salesTextsService.js";

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

/** Время и адрес — из раздела «Цены и даты» (те же, что в карточке бота и на
 *  сайте). Раньше здесь стояли зашитые «13:40» и «Воданасос, здание Dodo
 *  Pizza», а карточка бота в это же время называла другой адрес и часы. */
export function reminderText(language: "ru" | "tg", name: string, facts: OfflineFacts): string {
  const at = parseHours(facts.hours)?.from;
  if (language === "tg") {
    return (
      `${name ? `${name}, п` : "П"}агох курсамон сар мешавад.\n` +
      (at ? `Соати ${at} интизоратонем. ` : "") +
      `Сурога: ${offlineAddress(facts, "tg")}.\n` +
      `Продукты овардан лозим нест, хамааш аз мо. То дидор!`
    );
  }
  return (
    `${name ? `${name}, з` : "З"}автра начинается наш курс.\n` +
    (at ? `Ждём вас к ${at}. ` : "") +
    `Адрес: ${offlineAddress(facts, "ru")}.\n` +
    `Продукты приносить не нужно, всё наше. До встречи!`
  );
}

/**
 * Дата начала курса в настройках — строго ГГГГ-ММ-ДД.
 *
 * Отдельно от текста карточки («3 октября»): разбирать дату из человеческой
 * фразы значит однажды ошибиться на месяц и не напомнить вовсе, а тихая
 * ошибка здесь стоит владелице неполной группы. Пусто или мусор — напоминание
 * просто не работает, и это видно в логе.
 */
async function courseStartAt(facts: OfflineFacts): Promise<Date | null> {
  const date = await offlineStartDate();
  if (!date) return null;
  // Начало занятий по Душанбе (раздел «Цены и даты»); переводим в момент
  // времени сервера. Нераспознанные часы — полдень: напоминание всё равно уйдёт накануне.
  const [h, m] = (parseHours(facts.hours)?.from ?? "12:00").split(":").map(Number);
  const offset = await offsetMs();
  const midnightUtc = Date.UTC(date.year, date.month - 1, date.day);
  return new Date(midnightUtc - offset + h * 3_600_000 + m * 60_000);
}

export async function runOfflineReminders(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("offlineReminder", sweep);
}

async function sweep(): Promise<void> {
  if ((await getSetting("botFrozen")) === "true") return;
  const facts = await getOfflineFacts();
  const startAt = await courseStartAt(facts);
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
  const ownerChat = (await techChatIds())[0];
  const forOwner: string[] = [];
  let reachedInInstagram = 0;

  for (const signup of signups) {
    if ((await getSetting("botFrozen")) === "true") return;
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

    // Ширин хоть раз говорила с ней сама — клиентке не напоминаем никогда
    // (владелец 09.11.2026); владельцу строка ниже уходит как раньше.
    if (windowOpen && !(await everTalkedWithShirin(signup.contact))) {
      const language = await contactLanguage(signup.contactId, lastIn?.text ?? "");
      const text = reminderText(language === "tg" ? "tg" : "ru", signup.name, facts);
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
    const waText = encodeURIComponent(reminderText("ru", signup.name, facts));
    const waLink = `https://wa.me/992${signup.phone}?text=${waText}`;
    forOwner.push(
      [
        `${signup.name || "имя не указано"} — ${signup.phone}${windowOpen ? "" : " ← бот не смог написать"}`,
        who,
        waLink,
      ].join("\n"),
    );
  }

  if (botToken && ownerChat && forOwner.length > 0) {
    await sendTelegramMessage(
      botToken,
      ownerChat,
      `📣 Завтра начинается очный курс. Записалось: ${forOwner.length}\n` +
        `Боту удалось написать в Instagram: ${reachedInInstagram}\n\n` +
        `${forOwner.join("\n")}\n\n` +
        `Нажмите на ссылку под нужным человеком — откроется WhatsApp с уже написанным сообщением.`,
    ).catch((err) => logError("offlineReminder:notifyOwner", err));
  }

  logInfo("offlineReminder", `напомнили ${forOwner.length}, из них в Instagram ${reachedInInstagram}`);
}
