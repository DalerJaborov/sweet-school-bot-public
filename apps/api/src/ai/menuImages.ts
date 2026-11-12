import { prisma, recordOutgoingMessage, getSetting, logError } from "../db.js";
import { env } from "../env.js";
import { sendToContact, sendImageToContact, mediaAlreadySent } from "../messaging/send.js";
import { getPrices } from "../services/priceService.js";
import type { PriceTable } from "../prices.js";
import { contactLanguage } from "./contactLanguage.js";
import type { Contact } from "@prisma/client";

/**
 * ФОТО МЕНЮ ВМЕСТО ТЕКСТОВОГО СПИСКА (владелец 24.08.2026, расширено 11.11.2026:
 * «вместо тупого списка меню — красиво оформленные фото меню; спрашивают про
 * онлайн, офлайн или меню — фото»).
 *
 * Три меню: онлайн «21 рецепт», онлайн «арт-десерты» и офлайн-курс в Душанбе.
 *
 * ОДНО МЕСТО ДЛЯ ССЫЛОК — настройка `menuMediaUrls` (JSON: {"online70": [...],
 * "online50": [...], "offline": [...]}), её правит владелец; скрипт выкатки
 * ops/2026-11-11-bot-texts.mjs кладёт туда картинки, которые прислал владелец.
 * Пока настройки нет — значения ниже (те же картинки). Курс без картинок —
 * фото не шлём, отвечает текст.
 *
 * НЕ СПАМИМ: не больше MAX_MEDIA_PER_REPLY картинок за ответ, и файл, который
 * этому человеку уже уходил (воронкой, ботом, отзывом), второй раз не шлём —
 * messaging/send.ts::mediaAlreadySent.
 *
 * РУБИЛЬНИК `menuPhotosEnabled` — по умолчанию ВКЛЮЧЁН; "false" — фото меню
 * только по прямой просьбе «покажите меню» (как было), без фото после ответа.
 */
export type CourseKey = "online70" | "online50" | "offline";

export const MENU_MEDIA_SETTING = "menuMediaUrls";
export const MENU_PHOTOS_SETTING = "menuPhotosEnabled";
export const MAX_MEDIA_PER_REPLY = 2;

/**
 * Картинки, которые назвал владелец 11.11.2026: «МЕНЮ ОНЛАЙН-КУРСА» (21) и «МЕНЮ
 * КУРСА» офлайна — с сайта; арт-десерты — картинка шага 11 директ-воронки (так
 * велел владелец). Это запас на случай пустой настройки, а не второй источник.
 */
export const DEFAULT_MENU_MEDIA: Record<CourseKey, string[]> = {
  online70: ["https://shirinsweets.online/media/2a63855d-368c-40fc-b642-037a431e4def.jpg"],
  online50: [
    "https://shirinsweets.online/media/mb-f7e90459f2bd2579.png",
  ],
  offline: ["https://shirinsweets.online/media/11711421-2fc6-462b-9127-ec74e194ab97.jpg"],
};

const COURSE_KEYS: CourseKey[] = ["online70", "online50", "offline"];

/** Разбор настройки: мусор и не-https ссылки отбрасываются; пустая — запас выше. */
export function parseMenuMedia(raw: string | null | undefined): Record<CourseKey, string[]> {
  if (!raw?.trim()) return DEFAULT_MENU_MEDIA;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<CourseKey, unknown>>;
    const out = {} as Record<CourseKey, string[]>;
    for (const key of COURSE_KEYS) {
      const list = Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : DEFAULT_MENU_MEDIA[key];
      out[key] = list
        .filter((u): u is string => typeof u === "string" && /^https:\/\/\S+$/u.test(u.trim()))
        .map((u) => u.trim());
    }
    return out;
  } catch {
    return DEFAULT_MENU_MEDIA;
  }
}

export async function menuMedia(course: CourseKey): Promise<string[]> {
  return parseMenuMedia(await getSetting(MENU_MEDIA_SETTING))[course];
}

/** Картинки сайта (рисует apps/web/scripts/render-menu-cards.mjs) — для сайта и тестов. */
const FILE: Record<CourseKey, string> = {
  online70: "menu-online-70",
  online50: "menu-online-50",
  offline: "menu-offline",
};

export function menuImageUrl(course: CourseKey, lang: "ru" | "tg"): string {
  const base = (env.publicBaseUrl || "https://shirinsweets.online").replace(/\/+$/, "");
  return `${base}/img/menus/${FILE[course]}-${lang}.jpg`;
}

const CAPTION: Record<CourseKey, Record<"ru" | "tg", string>> = {
  online70: { ru: "Вот меню онлайн-курса «21 рецепт»", tg: "Ана менюи курси онлайн «21 рецепт»" },
  online50: { ru: "Вот что внутри курса «Арт-десерты»", tg: "Ана курси «Арт-десерты»" },
  offline: { ru: "Вот меню офлайн-курса в Душанбе", tg: "Ана менюи курси офлайн дар Душанбе" },
};

/** Признаки, по которым понятно, про какой курс речь. Цена курса («70 сомони») берётся
 *  из ТЕКУЩЕЙ таблицы «Цены и даты», а не вписана сюда. */
const MENTIONS_OFFLINE = /офлайн|оффлайн|offline|душанбе|очно|на\s+месте/iu;
function priceMentions(prices?: PriceTable): { online70: RegExp; online50: RegExp } {
  const p70 = prices?.price.COURSE70 ?? 70;
  const p50 = prices?.price.COURSE50 ?? 50;
  return {
    online70: new RegExp(String.raw`(?<!\d)${p70}\s*сомон|21\s*(намуд|рецепт|видео|дарс|десерт|ширин)`, "iu"),
    online50: new RegExp(String.raw`(?<!\d)${p50}\s*сомон|арт[\s-]?десерт|9\s*намуд|10\s*(дарс|урок)`, "iu"),
  };
}

function mentioned(blob: string, prices?: PriceTable): CourseKey[] {
  const re = priceMentions(prices);
  const found: CourseKey[] = [];
  if (MENTIONS_OFFLINE.test(blob)) found.push("offline");
  if (re.online70.test(blob)) found.push("online70");
  if (re.online50.test(blob)) found.push("online50");
  return found;
}

/**
 * Какой курс имеется в виду. Текущее сообщение главнее: назвал курс сам — историю не
 * слушаем. Иначе смотрим последние реплики (бот мог назвать курс раньше). Не поняли —
 * оба онлайн-меню: дороже смолчать про курс, чем прислать лишнюю картинку. Офлайн без
 * упоминания не шлём: тому, кто про него не спрашивал, это лишнее.
 */
export function inferCourses(currentText: string, recentTexts: string[], prices?: PriceTable): CourseKey[] {
  const now = mentioned(currentText, prices);
  if (now.length) return now;
  const before = mentioned(recentTexts.join("\n"), prices);
  if (before.length === 1) return before;
  if (before.length > 1) {
    const online = before.filter((c) => c !== "offline");
    return online.length ? online : before;
  }
  return ["online70", "online50"];
}

/**
 * Отправить фото меню курсов (подпись + картинка), не больше MAX_MEDIA_PER_REPLY
 * картинок и без повторов. Возвращает, сколько картинок ушло.
 */
export async function sendCourseMenus(
  contact: Contact,
  courses: CourseKey[],
  text: string,
  opts: { caption?: boolean } = {},
): Promise<number> {
  const lang = (await contactLanguage(contact.id, text)) === "tg" ? "tg" : "ru";
  let sent = 0;
  for (const course of courses) {
    if (sent >= MAX_MEDIA_PER_REPLY) break;
    const fresh: string[] = [];
    for (const url of await menuMedia(course)) if (!(await mediaAlreadySent(contact.id, url))) fresh.push(url);
    if (fresh.length === 0) continue;
    if (opts.caption !== false) {
      const caption = CAPTION[course][lang];
      const mid = await sendToContact(contact, caption);
      if (mid) await recordOutgoingMessage(contact.id, caption, mid);
    }
    for (const url of fresh) {
      if (sent >= MAX_MEDIA_PER_REPLY) break;
      await sendImageToContact(contact, url);
      sent++;
    }
  }
  return sent;
}

/** Вызывается из ai.ts вместо хода модели, когда detectMenuQuestion() узнал
 *  вопрос про список десертов курса (см. offTopicGuard.ts). Всё уже отправляли —
 *  возвращает false, и тогда отвечает модель (коротко, без списка). */
export async function sendMenuImages(contact: Contact, text: string): Promise<boolean> {
  const recent = await prisma.message.findMany({
    where: { contactId: contact.id, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { text: true },
  });
  const courses = inferCourses(
    text,
    (recent ?? []).map((m) => m.text ?? ""),
    await getPrices(),
  );
  return (await sendCourseMenus(contact, courses, text)) > 0;
}

/** Курс назван явно — словом «онлайн» без конкретики или его названием/ценой. */
const ONLINE_WORD = /(?<![.\p{L}])(онлайн\p{L}*|online|onlayn|onlain)(?!\p{L})/iu;

/**
 * После ответа модели: человек спросил про конкретный онлайн-курс («онлайн?»,
 * «21 рецепт чи дорад?», «арт десерт чанд?») — вдогонку одно фото меню этого
 * курса, если его ещё не показывали. Офлайн сюда не входит: его фото уходит
 * вместе с карточкой офлайна (ai.ts::sendOfflineCardAndHandOff).
 */
export async function maybeSendCourseMenuPhoto(contact: Contact, text: string): Promise<void> {
  if (!text || (await getSetting(MENU_PHOTOS_SETTING)) === "false") return;
  const prices = await getPrices();
  let courses = mentioned(text, prices).filter((c) => c !== "offline");
  if (courses.length === 0 && ONLINE_WORD.test(text)) courses = ["online70", "online50"];
  if (courses.length === 0) return;
  await sendCourseMenus(contact, courses.slice(0, 1), text).catch((err) => logError("menu:afterReply", err));
}

/** Фото меню офлайна — следом за карточкой офлайн-курса, без подписи (карточка уже всё сказала). */
export async function sendOfflineMenuPhoto(contact: Contact, text: string): Promise<void> {
  if ((await getSetting(MENU_PHOTOS_SETTING)) === "false") return;
  await sendCourseMenus(contact, ["offline"], text, { caption: false }).catch((err) => logError("menu:offline", err));
}
