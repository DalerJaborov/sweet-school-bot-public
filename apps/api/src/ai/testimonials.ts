import { prisma, recordOutgoingMessage } from "../db.js";
import { sendToContact, sendImageToContact } from "../messaging/send.js";
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

/** Если подписи у отзыва нет — уходит нейтральная фраза, а не голая картинка. */
const FALLBACK_CAPTION = "вот отзыв одной из наших учениц";


/**
 * Побочный эффект: увидев сомнение в СВЕЖЕМ входящем тексте, кладёт в директ
 * один скриншот отзыва — если ещё не присылали и человек ещё не оплатил.
 *
 * ЗАПУСКАЕТСЯ НЕЗАВИСИМО ОТ ОСНОВНОГО ОТВЕТА БОТА (см. вызов в ai.ts, тот же
 * fire-and-forget `.catch(...)`, что у notifyIfStuck/markStartedLearningIfReplied) —
 * это НЕ довесок к ответу модели, а своё отдельное сообщение, и падение здесь
 * не должно ни задержать, ни оборвать обычный ответ.
 *
 * Пул активных отзывов пуст — тихий no-op: ни ошибки, ни строки в журнале, это
 * штатное состояние, пока хозяйка не залила ни одного скриншота.
 */
export async function maybeSendTestimonial(contact: Contact, text: string): Promise<void> {
  if (!text || !hasDoubtSignal(text)) return;
  if (contact.testimonialSentAt) return; // уже присылали этому человеку — второй раз не давим
  if (contact.paid) return; // уже купил — убеждать больше не в чем

  // Круговая ротация: следующим всегда уходит отзыв, которого не показывали
  // дольше остальных (null — ещё ни разу), чтобы пул изнашивался равномерно.
  // Кандидатов берём НЕСКОЛЬКО: findFirst+update отдельными запросами — гонка
  // (два почти одновременных сомневающихся клиента читают один и тот же
  // "самый старый" отзыв ДО того, как кто-то из них его пометит показанным) —
  // оба получали бы один и тот же отзыв вместо ротации. Атомарно "забираем"
  // кандидата условным UPDATE (проверка lastShownAt не изменился с чтения);
  // если конкурентный запрос уже забрал самого старого — пробуем следующего.
  const candidates = await prisma.testimonial.findMany({
    where: { active: true },
    orderBy: [{ lastShownAt: "asc" }, { createdAt: "asc" }],
    take: 5,
  });
  if (candidates.length === 0) return;

  let testimonial: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const claimed = await prisma.testimonial.updateMany({
      where: { id: c.id, lastShownAt: c.lastShownAt },
      data: { lastShownAt: new Date() },
    });
    if (claimed.count === 1) {
      testimonial = c;
      break;
    }
  }
  if (!testimonial) return; // редкий случай: все 5 кандидатов только что забрали конкурентные запросы

  const caption = testimonial.caption?.trim() || FALLBACK_CAPTION;
  const mid = await sendToContact(contact, caption);
  await recordOutgoingMessage(contact.id, caption, mid);
  await sendImageToContact(contact, testimonial.imageUrl);
  await prisma.contact.update({ where: { id: contact.id }, data: { testimonialSentAt: new Date() } });
}
