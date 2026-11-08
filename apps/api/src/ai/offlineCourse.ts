import { prisma, getSetting, logError, recordOutgoingMessage } from "../db.js";
import { formatCourseDate, offlineStartDate, upcomingOfflineStartDate, type CalendarDay } from "./courseDate.js";
import { sendToContact } from "../messaging/send.js";
import { detectClientLanguage, type ClientLanguage } from "./clientLanguage.js";
import { DEFAULT_OFFLINE_FACTS, formatHours, offlineAddress, parseHours, pluralRu, type OfflineFacts } from "./offlineFacts.js";
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
 * С 08.11.2026 — три коротких сообщения словами владельца, без значков и тире:
 * «он пишет как бот». Абзацы разделены пустой строкой; maybeSendOfflineCard
 * шлёт каждый отдельным сообщением (offlineCardMessages), панель показывает целиком.
 */
export const OFFLINE_DATE_TBD: Record<"ru" | "tg", string> = {
  ru: "Дата следующего курса пока уточняется. Оставьте имя и номер, сообщим первой.",
  tg: "Санаи курси оянда хануз маълум нест. Ном и номер монен, маълум шавад хабар медихем.",
};

/** Абзацы карточки — отдельные сообщения, как пишет человек (не больше трёх). */
export const OFFLINE_CARD_MAX_MESSAGES = 3;

export function offlineCardMessages(card: string): string[] {
  const parts = card.split(/\n[ \t]*\n+/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= OFFLINE_CARD_MAX_MESSAGES) return parts;
  return [...parts.slice(0, OFFLINE_CARD_MAX_MESSAGES - 1), parts.slice(OFFLINE_CARD_MAX_MESSAGES - 1).join("\n\n")];
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
  facts: OfflineFacts = DEFAULT_OFFLINE_FACTS,
): string {
  // Текст — словами владельца (его карточка 08.11.2026: «Курси ояндамон 20 ноябр сар
  // мешавад 700 сом пули продукты наметиен…»), разбит на три коротких сообщения:
  // когда и сколько / что готовим / где и как записаться. Без значков и тире.
  // Числа (дата, цена, дни, часы, десерты, адрес) — из «Цены и даты», не из текста.
  const range = parseHours(facts.hours);
  if (language === "tg") {
    const when = start
      ? `Курси ояндамон ${formatCourseDate(start, "tg")} сар мешавад.`
      : OFFLINE_DATE_TBD.tg;
    const hours = range ? ` аз соати ${range.from} ба ${range.to}` : ` ${formatHours(facts.hours, "tg")}`;
    const seats = facts.seats ? ` Дар группа факат ${facts.seats} чой хаст.` : "";
    return [
      `${when} ${facts.price} сом, пули продукты наметиен. Курс ${facts.days} руз давом дорад,${hours}.${seats}`,
      `${facts.desserts} намуд ширини тайёр мекунем, арт десертхоям дохил мешан. Чизеки мепазем хамрох мебарен, охирда сертификат мегирен.`,
      `Сурога: ${offlineAddress(facts, "tg")}. Барои запись ном и номер монен, запись мекнем.`,
    ].join("\n\n");
  }
  const when = start ? `Следующий курс начинается ${formatCourseDate(start, "ru")}.` : OFFLINE_DATE_TBD.ru;
  // Мест — только если владелец задал число: «мест немного» без числа бот
  // говорить не должен, придуманная цифра хуже молчания.
  const seats = facts.seats ? ` В группе всего ${facts.seats} мест.` : "";
  return [
    `${when} Стоимость ${facts.price} сомони, продукты наши, приносить ничего не нужно. ` +
      `Курс ${facts.days} ${daysRu(facts.days)}, каждый день ${formatHours(facts.hours, "ru")}.${seats}`,
    `Готовим ${facts.desserts} ${pluralRu(facts.desserts, "вид", "вида", "видов")} десертов, арт-десерты тоже входят. ` +
      "Всё, что испекли, забираете с собой, в конце сертификат.",
    `Адрес: ${offlineAddress(facts, "ru")}. Для записи напишите имя и номер телефона.`,
  ].join("\n\n");
}

/**
 * ФАКТЫ ОФЛАЙН-КУРСА ДЛЯ МОДЕЛИ — одной строкой, из тех же настроек, что
 * карточка. Раньше в промт уходила только дата («(3 октября)»), а прошедшая
 * дата шла туда как есть (courseDateLabel не проверял, впереди ли она) —
 * модель звала на уже прошедший набор. Теперь: только будущая дата, иначе
 * прямой запрет её называть.
 */
export function offlineFactsLine(start: CalendarDay | null, facts: OfflineFacts): string {
  const date = start
    ? `начало ${formatCourseDate(start, "ru")}`
    : "дата следующего набора уточняется — дату НЕ называй, предложи записаться, сообщим первой";
  return (
    `Офлайн-курс: ${date}; ${facts.days} ${daysRu(facts.days)}, каждый день ${formatHours(facts.hours, "ru")}; ` +
    `${facts.price} сомони, продукты включены, предоплаты нет; адрес: ${facts.address}` +
    (facts.seats ? `; в группе ${facts.seats} мест` : "")
  );
}

/** То же для живого хода бота — из настроек. */
export async function offlineFactsForModel(): Promise<string> {
  return offlineFactsLine(await upcomingOfflineStartDate(), await getOfflineFacts());
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
    // Несколько коротких сообщений вместо одной простыни (владелец 08.11.2026).
    // Упало посередине — отметку снимаем ниже, повтор пришлёт карточку целиком.
    for (const part of offlineCardMessages(text)) {
      const mid = await sendToContact(contact, part);
      await recordOutgoingMessage(contact.id, part, mid);
    }
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
