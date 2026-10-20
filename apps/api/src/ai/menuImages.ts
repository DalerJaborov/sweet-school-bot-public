import { prisma, recordOutgoingMessage } from "../db.js";
import { sendToContact, sendImageToContact } from "../messaging/send.js";
import type { Contact } from "@prisma/client";

/**
 * КАРТИНКИ МЕНЮ ВМЕСТО ТЕКСТА МОДЕЛИ.
 *
 * Те же изображения, что уже уходят на шаге 11/21 обеих приветственных воронок
 * (см. FunnelStep.mediaUrl) — здесь просто переиспользуются по прямой ссылке,
 * без похода в базу за шагом воронки: это разные вещи (там — заготовленная
 * последовательность для новых людей, тут — ответ на вопрос посреди разговора).
 */
type CourseKey = "COURSE50" | "COURSE70";

const MENU_IMAGE: Record<CourseKey, string> = {
  COURSE50:
    "https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/fb4433534/ca/big_69c2e6c900233215cc5859be98a8dfac.png",
  COURSE70:
    "https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/fb4433534/ca/big_520f0415e6e8186f74549581ec462c91.jpg",
};

const CAPTION: Record<CourseKey, string> = {
  COURSE50: "Дар курси 50 сомона инхо дохил мешаванд",
  COURSE70: "Дар курси 70 сомона инхо дохил мешаванд",
};

/** Признаки, по которым разговор уже понятно про какой курс — те же слова, что
 *  использует сам промт («70 сомони», «21 намуд», «арт-десерт», «9 намуд»). */
const MENTIONS_70 = /70\s*сомон|21\s*(намуд|рецепт|видео|дарс)/iu;
const MENTIONS_50 = /50\s*сомон|арт[\s-]?десерт|9\s*намуд/iu;

/**
 * Какой курс имеется в виду — смотрим на текущее сообщение и последние
 * несколько реплик разговора (в обе стороны: бот мог сам назвать курс раньше).
 * Не поняли, какой именно, — шлём ОБА меню: дороже смолчать про один из них,
 * чем прислать лишнюю картинку.
 */
async function inferCourses(contactId: string, currentText: string): Promise<CourseKey[]> {
  const recent = await prisma.message.findMany({
    where: { contactId, text: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { text: true },
  });
  const blob = [currentText, ...recent.map((m) => m.text ?? "")].join("\n");
  const has70 = MENTIONS_70.test(blob);
  const has50 = MENTIONS_50.test(blob);
  if (has70 && !has50) return ["COURSE70"];
  if (has50 && !has70) return ["COURSE50"];
  return ["COURSE70", "COURSE50"];
}


/** Вызывается из ai.ts вместо хода модели, когда detectMenuQuestion() узнал
 *  вопрос про список десертов курса (см. offTopicGuard.ts). */
export async function sendMenuImages(contact: Contact, text: string): Promise<void> {
  const courses = await inferCourses(contact.id, text);
  for (const course of courses) {
    const mid = await sendToContact(contact, CAPTION[course]);
    await recordOutgoingMessage(contact.id, CAPTION[course], mid);
    await sendImageToContact(contact, MENU_IMAGE[course]);
  }
}
