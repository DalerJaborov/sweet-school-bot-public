import { prisma, recordOutgoingMessage, getSetting } from "../db.js";
import { sendToContact, sendImageToContact, mediaAlreadySent } from "../messaging/send.js";
import { contactLanguage } from "./contactLanguage.js";
import { rx } from "./offTopicGuard.js";
import type { Contact } from "@prisma/client";

/**
 * НАСТОЯЩЕЕ СОЦИАЛЬНОЕ ДОКАЗАТЕЛЬСТВО — КАРТИНКОЙ, А НЕ ССЫЛКОЙ.
 *
 * У хозяйки уже есть актуальное в Instagram со скриншотами настоящих отзывов
 * учениц, и промт даёт на него ссылку («отзывы: instagram.com/stories/highlights/…»).
 * Но ссылку, которую нужно открыть отдельно, открывают немногие — а картинку,
 * положенную прямо в переписку, видят все. Здесь код (не модель — вложение
 * модель прикрепить не может) ловит момент, когда человек засомневался, и сам
 * кладёт в директ один скриншот отзыва.
 *
 * ТРИГГЕР НАРОЧНО В КОДЕ, А НЕ В ПРОМТЕ. Промт можно уговорить или он может
 * просто забыть — а решение «прислать картинку» либо срабатывает, либо нет,
 * середины тут не бывает: то же самое рассуждение, что у offTopicGuard.ts.
 *
 * ОДИН РАЗ НА ЧЕЛОВЕКА (Contact.testimonialSentAt). Разослать одно и то же фото
 * пять раз за разговор — не убеждает, а раздражает: одно живое доказательство
 * либо срабатывает, либо нет.
 */
const DOUBT_HINT = rx([
  "сомнева", // сомневаюсь, сомневаешься, сомневается
  "не\\s+увер(ен|ена|ены)?(?!\\p{L})", // не уверен(а) / не уверены
  "подума(ю|ть|ем|ла|л)?(?!\\p{L})", // подумаю / надо подумать
  "бо(юсь|ится|ишься)|побаива", // боюсь / боится / побаиваюсь
  "получится\\s+ли|получится\\s+у\\s+меня|у\\s+меня\\s+получится",
  "а\\s+вдруг\\s+не\\s+смогу|вдруг\\s+не\\s+получится|вдруг\\s+не\\s+выйдет",
  "(?<!не)дорог(о|овато|ая|ой)(?!\\p{L})", // «дорого», но не «недорого» и не «дорога»
  "не\\s+справлюсь|не\\s+потяну|не\\s+осилю",
  // Те же сомнения на таджикском.
  "боварӣ\\s+надорам|боварам\\s+нест", // не уверена
  "метарсам|тарс\\s+дорам", // боюсь
  "оё\\s+мешавад|оё\\s+метавонам", // получится ли / смогу ли
  "қимат|кимат", // дорого
]);

/** Есть ли в тексте признак колебания клиента — используется как код-триггер,
 *  не как классификация для модели. */
export function hasDoubtSignal(text: string): boolean {
  return DOUBT_HINT.test(text.trim());
}

/**
 * «ПОКАЖИТЕ ОТЗЫВЫ» / «РОСТ?» / «НАТИҶА?» — прямая просьба доказать (владелец
 * 11.11.2026). Это не сомнение по словам, но ответ на неё тот же: отзывы учениц.
 */
const PROOF_ASK = rx([
  "отзыв|отзывы|отзывов",
  String.raw`(?<!\p{L})(натиҷа|натича|натиҷаҳо|натичахо)\p{L}*`,
  String.raw`(?<!\p{L})рост(\s*(ми|ай|аст|мегу\p{L}*))?\s*\?`,
  String.raw`результат\p{L}*\s+(учениц|ваших|у\s+кого)|кто\s+(уже\s+)?(учился|училась|проходил)`,
  String.raw`(шогирд|хонанда)\p{L}*\s+(чи|чӣ)\s+(мегу|гуфт)`,
  String.raw`фикр\p{L}*\s+(шогирд|хонанда)`,
]);

export function asksForProof(text: string): boolean {
  return PROOF_ASK.test((text ?? "").trim());
}

export const TESTIMONIALS_SETTING = "testimonialsEnabled";
export const TESTIMONIAL_BATCH_SETTING = "testimonialBatchSize";
export const TESTIMONIALS_LINK_SETTING = "testimonialsLinkUrl";
/** «Одна пачка на разговор»: следующая — не раньше чем через неделю тишины. */
export const TESTIMONIAL_AGAIN_AFTER_MS = 7 * 86_400_000;
const DEFAULT_BATCH = 3;
const MAX_BATCH = 5;

/** Если подписи у отзыва нет — уходит нейтральная фраза, а не голая картинка. */
const INTRO: Record<"ru" | "tg", string> = {
  ru: "Вот отзывы наших учениц",
  tg: "Ана фикри шогирдони мо",
};
const LINK_LINE: Record<"ru" | "tg", string> = {
  ru: "Ещё отзывы здесь:",
  tg: "Боз фикрхо ин чо:",
};

async function batchSize(): Promise<number> {
  const n = Number.parseInt((await getSetting(TESTIMONIAL_BATCH_SETTING))?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_BATCH) : DEFAULT_BATCH;
}

/**
 * Побочный эффект: увидев сомнение или просьбу показать отзывы в СВЕЖЕМ входящем
 * тексте, кладёт в директ ПАЧКУ скриншотов отзывов (3 по умолчанию, не больше 5;
 * владелец 11.11.2026: «можно пачкой») и, если владелец задал, ссылку на
 * актуальные Instagram (настройка testimonialsLinkUrl; пусто — ссылки нет).
 *
 * Одна пачка на разговор (Contact.testimonialSentAt, повтор — через неделю);
 * купившему не шлём; ротация по lastShownAt, только active; картинку, которая уже
 * уходила этому человеку, не повторяем. Рубильник testimonialsEnabled ("false"
 * выключает). Сбой не трогает основной ответ (вызов fire-and-forget в ai.ts).
 */
export async function maybeSendTestimonial(contact: Contact, text: string): Promise<void> {
  if (!text || !(hasDoubtSignal(text) || asksForProof(text))) return;
  if ((await getSetting(TESTIMONIALS_SETTING)) === "false") return;
  if (contact.testimonialSentAt && Date.now() - contact.testimonialSentAt.getTime() < TESTIMONIAL_AGAIN_AFTER_MS)
    return;
  if (contact.paid) return; // уже купил — убеждать больше не в чем

  // Пачку «забираем» отметкой в контакте ДО отправки: два сообщения подряд с
  // сомнением не должны прислать две пачки.
  const claimed = await prisma.contact.updateMany({
    where: {
      id: contact.id,
      OR: [
        { testimonialSentAt: null },
        { testimonialSentAt: { lt: new Date(Date.now() - TESTIMONIAL_AGAIN_AFTER_MS) } },
      ],
    },
    data: { testimonialSentAt: new Date() },
  });
  if (claimed.count === 0) return;

  const want = await batchSize();
  // Круговая ротация: следующими уходят отзывы, которых не показывали дольше
  // остальных (null — ещё ни разу). Каждого кандидата забираем условным UPDATE
  // (lastShownAt не изменился с чтения) — два одновременных клиента не получат
  // одни и те же картинки.
  const candidates = await prisma.testimonial.findMany({
    where: { active: true },
    orderBy: [{ lastShownAt: "asc" }, { createdAt: "asc" }],
    take: want * 3,
  });
  const picked: (typeof candidates)[number][] = [];
  for (const c of candidates) {
    if (picked.length >= want) break;
    if (await mediaAlreadySent(contact.id, c.imageUrl)) continue;
    const ok = await prisma.testimonial.updateMany({
      where: { id: c.id, lastShownAt: c.lastShownAt },
      data: { lastShownAt: new Date() },
    });
    if (ok.count === 1) picked.push(c);
  }
  if (picked.length === 0) {
    // Показывать нечего — отметку снимаем, пачка не потрачена.
    await prisma.contact.update({
      where: { id: contact.id },
      data: { testimonialSentAt: contact.testimonialSentAt ?? null },
    });
    return;
  }

  const lang = (await contactLanguage(contact.id, text)) === "tg" ? "tg" : "ru";
  const intro = picked.length === 1 ? picked[0].caption?.trim() || INTRO[lang] : INTRO[lang];
  const mid = await sendToContact(contact, intro);
  await recordOutgoingMessage(contact.id, intro, mid);
  for (const t of picked) await sendImageToContact(contact, t.imageUrl);
  const link = (await getSetting(TESTIMONIALS_LINK_SETTING))?.trim();
  if (link && /^https:\/\/\S+$/u.test(link)) {
    const line = `${LINK_LINE[lang]} ${link}`;
    const linkMid = await sendToContact(contact, line);
    await recordOutgoingMessage(contact.id, line, linkMid);
  }
}
