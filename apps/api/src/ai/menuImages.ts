import { prisma, recordOutgoingMessage } from "../db.js";
import { env } from "../env.js";
import { sendToContact, sendImageToContact } from "../messaging/send.js";
import { detectClientLanguage } from "./clientLanguage.js";
import type { Contact } from "@prisma/client";

/**
 * КАРТИНКИ МЕНЮ ВМЕСТО ТЕКСТА МОДЕЛИ.
 *
 * Три меню — онлайн «21 рецепт», онлайн «арт-десерты» и офлайн-курс в Душанбе — на двух
 * языках. Картинки рисует `apps/web/scripts/render-menu-cards.mjs` из тех же файлов, что
 * собирают сайт, и лежат на сайте (`/img/menus/…`), откуда их забирает Meta. Цен и дат на
 * них нет нарочно: они меняются в «Текстах и ценах», картинка устарела бы молча.
 *
 * Названия десертов на таджикском остаются русскими — правило владельца 08.11.2026.
 */
export type CourseKey = "online70" | "online50" | "offline";

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
  online70: { ru: "Вот что входит в онлайн-курс «21 рецепт»", tg: "Инҳо ба курси онлайн «21 рецепт» дохил мешаванд" },
  online50: { ru: "Вот программа курса «Арт-десерты»", tg: "Ин барномаи курси «Арт-десерты» аст" },
  offline: { ru: "Вот как проходит офлайн-курс в Душанбе", tg: "Курси офлайн дар Душанбе ингуна мегузарад" },
};

/** Признаки, по которым понятно, про какой курс речь. */
const MENTIONS_OFFLINE = /офлайн|оффлайн|offline|душанбе|очно|на\s+месте/iu;
const MENTIONS_70 = /70\s*сомон|21\s*(намуд|рецепт|видео|дарс|десерт|ширин)/iu;
const MENTIONS_50 = /50\s*сомон|арт[\s-]?десерт|9\s*намуд|10\s*(дарс|урок)/iu;

function mentioned(blob: string): CourseKey[] {
  const found: CourseKey[] = [];
  if (MENTIONS_OFFLINE.test(blob)) found.push("offline");
  if (MENTIONS_70.test(blob)) found.push("online70");
  if (MENTIONS_50.test(blob)) found.push("online50");
  return found;
}

/**
 * Какой курс имеется в виду. Текущее сообщение главнее: назвал курс сам — историю не
 * слушаем. Иначе смотрим последние реплики (бот мог назвать курс раньше). Не поняли —
 * оба онлайн-меню: дороже смолчать про курс, чем прислать лишнюю картинку. Офлайн без
 * упоминания не шлём: тому, кто про него не спрашивал, это лишнее.
 */
export function inferCourses(currentText: string, recentTexts: string[]): CourseKey[] {
  const now = mentioned(currentText);
  if (now.length) return now;
  const before = mentioned(recentTexts.join("\n"));
  if (before.length === 1) return before;
  if (before.length > 1) {
    const online = before.filter((c) => c !== "offline");
    return online.length ? online : before;
  }
  return ["online70", "online50"];
}

/** Вызывается из ai.ts вместо хода модели, когда detectMenuQuestion() узнал
 *  вопрос про список десертов курса (см. offTopicGuard.ts). */
export async function sendMenuImages(contact: Contact, text: string): Promise<void> {
  const recent = await prisma.message.findMany({
    where: { contactId: contact.id, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { text: true },
  });
  const courses = inferCourses(text, recent.map((m) => m.text ?? ""));
  const lang = detectClientLanguage(text) === "tg" ? "tg" : "ru";
  for (const course of courses) {
    const caption = CAPTION[course][lang];
    const mid = await sendToContact(contact, caption);
    await recordOutgoingMessage(contact.id, caption, mid);
    await sendImageToContact(contact, menuImageUrl(course, lang));
  }
}
