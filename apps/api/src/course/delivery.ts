import { prisma, getSetting, logError } from "../db.js";
import { issueMagicLink } from "./access.js";
import { courseByCode } from "../services/courseCatalog.js";
import type { Course } from "../courses.js";

/**
 * ЧТО ИМЕННО ОТПРАВИТЬ ЧЕЛОВЕКУ ПОСЛЕ ОПЛАТЫ.
 *
 * Раньше ответ был один — одноразовая ссылка в закрытую Telegram-группу. Теперь
 * есть вторая дверь, собственная платформа, и переход должен быть постепенным:
 * у школы уже есть ученицы, привыкшие к группе, и ломать им привычное нельзя,
 * а новым как раз нужна платформа — половина из них с Telegram не справилась.
 *
 * Режим переключается настройкой `courseDeliveryMode`:
 *   telegram — как раньше, только группа (значение по умолчанию: новая
 *              возможность не должна включиться сюрпризом после деплоя);
 *   web      — только платформа;
 *   both     — обе ссылки в одном сообщении, человек выбирает сам.
 *
 * Здесь же живёт привязка покупки к курсу из каталога: пока backfill не
 * прошёл, courseId пуст, и платформа честно скажет «курс готовится» вместо
 * пустого экрана.
 */

export type DeliveryMode = "telegram" | "web" | "both";

export async function deliveryMode(): Promise<DeliveryMode> {
  const raw = (await getSetting("courseDeliveryMode"))?.trim();
  return raw === "web" || raw === "both" ? raw : "telegram";
}

/**
 * Режим доставки ДЛЯ КОНКРЕТНОГО ЧЕЛОВЕКА. Пришедшей с сайта Telegram-группа
 * не нужна вовсе (у неё и Telegram может не быть — ради этого сайт и делался),
 * поэтому канал WEB всегда получает ссылку на платформу, какой бы режим ни
 * стоял в настройках. Для Instagram/Messenger — как настроил владелец.
 */
export async function deliveryModeFor(contact: { channel: string }): Promise<DeliveryMode> {
  return contact.channel === "WEB" ? "web" : deliveryMode();
}

/**
 * Выдать ссылку на платформу для уже созданной покупки.
 *
 * Каждый вызов выпускает НОВУЮ ссылку и запоминает её идентификатор: прошлая
 * сразу перестаёт работать. Так «вернуть доступ» после ошибочного отзыва не
 * оживляет старое письмо, которое могли переслать.
 */
export async function issueCourseLink(contactId: string): Promise<string | null> {
  const base = await courseLinkBase();
  if (!base) return null;
  // Ссылка — на ЧЕЛОВЕКА: одна на все купленные курсы (см. access.ts).
  const { url, jti } = issueMagicLink(contactId);
  await prisma.contact.update({
    where: { id: contactId },
    data: { accessTokenId: jti, accessIssuedAt: new Date() },
  });
  return url;
}

/** Переходная обёртка для кода, у которого под рукой только покупка. */
export async function issueCourseLinkForPurchase(purchaseId: string): Promise<string | null> {
  const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId }, select: { contactId: true } });
  return purchase ? issueCourseLink(purchase.contactId) : null;
}

/**
 * Курс каталога реально готов на платформе — в нём есть хотя бы один урок.
 * «Арт-десерты» заведён в базе (цена, название), но материалы ещё не
 * импортированы — до импорта это пустая страница без единого урока.
 *
 * Выдать на неё ссылку человеку, который только что заплатил, нельзя (найдено
 * ревизией 04.09.2026: платформа честно скажет «курс готовится», только если
 * НИ ОДНОГО купленного курса нет в каталоге вовсе — для одного пустого курса
 * среди прочих такой защиты не было). Если для канала WEB отдать ссылку
 * нельзя, grantCourses сам уйдёт по уже проверенному пути «ссылки нет» — чек
 * уедет на ручную проверку владельцу вместо тихого «оплачено, но пусто».
 */
export async function coursePlatformReady(code: Course): Promise<boolean> {
  const course = await courseByCode(code);
  if (!course) return false;
  const count = await prisma.lesson.count({ where: { deletedAt: null, module: { courseId: course.id } } });
  return count > 0;
}

/** Платформа готова принимать людей, только если известен её адрес. */
async function courseLinkBase(): Promise<string | null> {
  const { env } = await import("../env.js");
  return env.publicBaseUrl || null;
}

/** Привязать покупку к курсу каталога по старому строковому коду. Молча
 *  пропускает, если каталога ещё нет — это не ошибка, а «backfill не запускали». */
export async function linkPurchaseToCourse(purchaseId: string, courseCode: string): Promise<void> {
  const course = await courseByCode(courseCode);
  if (!course) return;
  await prisma.purchase
    .update({ where: { id: purchaseId }, data: { courseId: course.id } })
    .catch((err) => logError("course:linkPurchase", err));
}

/**
 * Текст сообщения с доступом. Собирается из того, что реально получилось
 * выдать: если Telegram не настроен, а платформа есть — уйдёт только она, и
 * наоборот. Обе пустые — вызывающий код обязан считать выдачу неудавшейся.
 */
export function accessMessage(opts: {
  courseTitle: string | null;
  telegramLink: string | null;
  webLink: string | null;
  /** Несколько курсов в одном сообщении — тогда название обязательно. */
  withTitle: boolean;
  /** Язык клиентки — по последнему входящему. Без него русский. */
  language?: "ru" | "tg" | "en";
  /** Докупила второй курс: ссылка та же, окно то же — так и говорим. */
  added?: boolean;
}): string | null {
  const lines: string[] = [];
  if (opts.withTitle && opts.courseTitle) lines.push(opts.courseTitle);
  const tg = opts.language === "tg";

  if (opts.webLink && !opts.telegramLink && opts.added) {
    lines.push(
      tg ? "Курси дуюм илова шуд 🎉" : "Второй курс добавлен 🎉",
      "",
      tg ? "Он аллакай дар кабинети шумост — ҳамон линкро кушоед:" : "Он уже в вашем кабинете — откройте ту же ссылку:",
      opts.webLink
    );
    return lines.join("\n");
  }

  if (opts.webLink && opts.telegramLink) {
    lines.push(
      "Ваш курс открыт 🎉",
      "",
      `Смотреть на сайте (работает без Telegram, уроки сохраняются в телефоне):`,
      opts.webLink,
      "",
      "Или в Telegram-группе:",
      opts.telegramLink
    );
  } else if (opts.webLink) {
    lines.push(
      tg ? "Дарси шумо кушода шуд 🎉" : "Ваш курс открыт 🎉",
      "",
      tg ? "Ҳамаи дарсҳо ин ҷо — линкро дар телефон кушоед:" : "Все уроки здесь — откройте ссылку на телефоне:",
      opts.webLink,
      "",
      tg
        ? "Ин линк шахсии шумост: бо он ҳамаи курсҳои харидаатон кушода мешаванд. Саҳифаро ба экрани «Домой» илова кунед — дарсҳо бе интернет ҳам кор мекунанд."
        : "Эта ссылка ваша личная: по ней откроются все купленные курсы. Добавьте страницу на экран «Домой» — уроки будут открываться без интернета."
    );
  } else if (opts.telegramLink) {
    lines.push(opts.telegramLink);
  } else {
    return null;
  }
  return lines.join("\n");
}
