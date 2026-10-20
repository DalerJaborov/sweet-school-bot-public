import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { formatCourseDate, offlineStartDate, upcomingOfflineStartDate, type CalendarDay } from "./courseDate.js";
import { sendToContact } from "../messaging/send.js";
import { detectClientLanguage, type ClientLanguage } from "./clientLanguage.js";
import { DEFAULT_OFFLINE_FACTS, type OfflineFacts } from "./offlineFacts.js";
import { getOfflineFacts } from "../services/salesTextsService.js";
import type { Contact } from "@prisma/client";

export { DEFAULT_OFFLINE_FACTS, type OfflineFacts } from "./offlineFacts.js";

/**
 * КАРТОЧКА ОФЛАЙН-КУРСА — то, что человек видит, спросив про очные занятия.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ СООБЩЕНИЕМ, А НЕ ЧЕРЕЗ МОДЕЛЬ. Раньше сведения о наборе
 * подмешивались в промт, и ответ сочиняла модель. Она неизбежно пересказывала:
 * меняла порядок, теряла адрес, сливала всё в один абзац. Человек на телефоне
 * такой текст не читает, а пробегает глазами — и не находит ни цены, ни
 * времени. Здесь текст уходит ДОСЛОВНО так, как его написал владелец: он сам
 * решает, что важно и в каком порядке.
 *
 * ЯЗЫК. Две версии, таджикская и русская, выбирается по языку переписки
 * (ai/clientLanguage.ts). Половина учениц пишет по-таджикски, и получить в
 * ответ русский текст для них то же самое, что не получить ничего.
 *
 * ОДИН РАЗ НА ЧЕЛОВЕКА. Отметка в контакте: спросил повторно — не заваливаем
 * той же простынёй, разговор продолжает обычный консультант.
 */

/**
 * Заготовка карточки. Живёт в коде только как запасной вариант: владелец может
 * заменить весь текст в панели (Настройки → «Офлайн-курс»).
 *
 * ДАТА НЕ ЗАШИТА (решение 05.09.2026): строка «Начало: …» строится из
 * настройки offlineCourseStartDate, и только пока дата впереди. Прошла или не
 * задана — вместо неё честное «дата уточняется», а не дата прошлого набора.
 * Факты (время, число десертов, адрес) — те же, что на сайте: владелец
 * вычитывал текст сайта последним, и бот не должен с ним спорить.
 *
 * Строки короткие и с ведущим значком нарочно: так на экране телефона видно
 * ровно одну мысль в строке, и глаз находит цену или адрес за секунду.
 */
export const OFFLINE_DATE_TBD: Record<"ru" | "tg", string> = {
  ru: "📅 Дата следующего набора уточняется — напишите, сообщим первой",
  tg: "📅 Санаи қабули оянда аниқ мешавад — нависед, аввал ба шумо мегӯем",
};

/** «14:00 до 17:00» → «14:00 то 17:00»: по-таджикски предлог другой, а часы те же. */
function hoursTg(hours: string): string {
  return hours.replace(/\s+до\s+/u, " то ");
}

/** Адрес по умолчанию по-таджикски; свой адрес владелец пишет один раз, и он
 *  уходит в обе версии как есть — улицы Душанбе понятны на обоих языках. */
function addressTg(address: string): string {
  return address === DEFAULT_OFFLINE_FACTS.address ? "Душанбе, кӯчаи Рӯдакӣ, 156а" : address;
}

function daysRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

/** Заготовка карточки. `facts` — цена/дни/часы/десерты/адрес из раздела
 *  «Тексты и цены» (services/salesTextsService.getOfflineFacts); без них —
 *  значения по умолчанию, те же, что на сайте. */
export function offlineCardDefault(
  language: "ru" | "tg",
  start: CalendarDay | null,
  facts: OfflineFacts = DEFAULT_OFFLINE_FACTS
): string {
  const dateLine = start
    ? `📅 ${language === "tg" ? "Оғоз" : "Начало"}: ${formatCourseDate(start, language)}`
    : OFFLINE_DATE_TBD[language];
  const lines =
    language === "tg"
      ? [
          "🍰 Курси офлайнӣ дар Душанбе",
          "",
          dateLine,
          `📆 Давомнокӣ: ${facts.days} рӯз`,
          `⏰ Ҳар рӯз аз ${hoursTg(facts.hours)}`,
          "",
          `💰 Нарх: ${facts.price} сомонӣ`,
          "🛒 Маҳсулот аз мо — чизе овардан лозим нест",
          "",
          `🧁 ${facts.desserts} намуд ширинӣ мепазем`,
          "🎁 Он чӣ пухтед — бо худ мебаред",
          "📜 Дар охир сертификат мегиред",
          "",
          `📍 ${addressTg(facts.address)}`,
          "",
          "✍️ Барои сабти ном ном ва рақами телефонатонро нависед",
        ]
      : [
          "🍰 Офлайн-курс в Душанбе",
          "",
          dateLine,
          `📆 Длительность: ${facts.days} ${daysRu(facts.days)}`,
          `⏰ Каждый день с ${facts.hours}`,
          "",
          `💰 Стоимость: ${facts.price} сомони`,
          "🛒 Продукты наши — приносить ничего не нужно",
          "",
          `🧁 Готовим ${facts.desserts} видов десертов`,
          "🎁 Всё, что испекли, забираете с собой",
          "📜 В конце — сертификат",
          "",
          `📍 ${facts.address}`,
          "",
          "✍️ Для записи напишите имя и номер телефона",
        ];
  return lines.join("\n");
}

/** Текст карточки на нужном языке: из настроек дословно, иначе заготовка с
 *  актуальной датой набора (или «уточняется»). */
export async function offlineCourseCard(language: ClientLanguage): Promise<string> {
  const key = language === "tg" ? "offlineCourseInfoTg" : "offlineCourseInfo";
  const custom = (await getSetting(key))?.trim();
  if (custom) return custom;
  // Английского набора нет: очный курс идёт в Душанбе, и приезжают на него
  // местные. Англоязычной клиентке отдаём русский вариант.
  return offlineCardDefault(language === "tg" ? "tg" : "ru", await upcomingOfflineStartDate(), await getOfflineFacts());
}

/** Граница «прошлого набора»: дата старта минус два месяца; null — дата не задана. */
async function previousIntakeCutoff(): Promise<Date | null> {
  const start = await offlineStartDate();
  if (!start) return null;
  return new Date(Date.UTC(start.year, start.month - 1, start.day) - 60 * 86_400_000);
}

/**
 * Отправляет карточку, если этому человеку её ещё не слали. Возвращает true,
 * если отправили — тогда консультанту остаётся только попросить имя и номер,
 * а пересказывать условия уже не нужно.
 */
export async function maybeSendOfflineCard(contact: Contact, clientText: string): Promise<boolean> {
  // Отметка «уже слали» привязана к НАБОРУ, а не к человеку навсегда. Раньше
  // она не сбрасывалась никогда: спросившая про октябрьский набор и не
  // пришедшая в ноябре не получала карточку с новой датой — за несколько
  // наборов это выкашивало весь тёплый список (разбор 03.09.2026). Карточка,
  // отправленная раньше, чем за два месяца до текущей даты старта, считается
  // карточкой прошлого набора.
  const cutoff = await previousIntakeCutoff();
  if (contact.offlineInfoSentAt && !(cutoff && contact.offlineInfoSentAt < cutoff)) return false;

  // Отметку ставим ПЕРЕД отправкой: карточка длинная, и получить её дважды
  // из-за гонки двух сообщений подряд неприятнее, чем не получить вовсе
  // (во втором случае человек переспросит, и ответит живой консультант).
  const claimed = await prisma.contact.updateMany({
    where: {
      id: contact.id,
      OR: [{ offlineInfoSentAt: null }, ...(cutoff ? [{ offlineInfoSentAt: { lt: cutoff } }] : [])],
    },
    data: { offlineInfoSentAt: new Date() },
  });
  if (claimed.count === 0) return false;

  const text = await offlineCourseCard(detectClientLanguage(clientText));
  try {
    const mid = await sendToContact(contact, text);
    await recordOutgoingMessage(contact.id, text, mid);
    return true;
  } catch (err) {
    logError("offlineCourse:send", err);
    // Не ушло — снимаем отметку, чтобы человек получил карточку со следующей
    // попыткой, а не остался без ответа навсегда.
    await prisma.contact
      .update({ where: { id: contact.id }, data: { offlineInfoSentAt: null } })
      .catch((e) => logError("offlineCourse:unmark", e));
    return false;
  }
}
