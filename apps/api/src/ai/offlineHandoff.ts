import { prisma, getSetting, logError } from "../db.js";
import type { Contact } from "@prisma/client";
import { hasDoubtSignal } from "./testimonials.js";

/**
 * «ОФЛАЙН: ПЕРЕДАНО ШИРИН» — состояние диалога (владелец 08.11.2026).
 *
 * Слова владельца: «По офлайн курсам консультировать не надо, только первые
 * сообщения, которые у нас через воронку есть. Если клиент написал, что офлайн,
 * пусть бот отправляет информацию про офлайн курс, и всё. Дальнейшая
 * консультация не нужна, дальше консультирует сама Ширин — если только во время
 * этого клиент не напишет, что ей нужен онлайн. Если снова скажет онлайн, бот
 * сразу подключается и обслуживает дальше».
 *
 * КАК УСТРОЕНО. Карточка офлайн-курса (ai/offlineCourse.ts, текст со значками
 * уходит дословно) остаётся единственным ответом бота на интерес к очному
 * курсу. После неё на контакте ставится отметка `offlineHandoffAt`, и
 * ai.ts::aiReply на любое следующее сообщение этого человека молчит — ни
 * текста, ни голоса (голос рождается внутри того же хода). Воронка (funnel.ts)
 * и служебные вещи (запись номера на офлайн — registerOfflineIfAsked в
 * webhook.ts, спасение фото чека, выбор способа доставки) живут выше по
 * цепочке и этой отметки не видят — как и просил владелец: «первые сообщения
 * через воронку» остаются.
 *
 * ВЫХОД. Человек пишет про онлайн (рус./тадж./латиница) — отметка снимается,
 * и бот обслуживает как обычно с этого же сообщения. Купивший онлайн-курс
 * (paid) тоже выходит из состояния сам: раз заплатил за онлайн, очный разговор
 * закончен.
 *
 * РУБИЛЬНИК `offlineHandoffEnabled` — по умолчанию ВКЛЮЧЁН (поведение заказано
 * владельцем явно); «false» возвращает прежний порядок: после карточки
 * консультант продолжает отвечать и просит имя и номер.
 */

export const OFFLINE_HANDOFF_SETTING = "offlineHandoffEnabled";

export async function offlineHandoffEnabled(): Promise<boolean> {
  return (await getSetting(OFFLINE_HANDOFF_SETTING)) !== "false";
}

/**
 * Человек говорит про ОНЛАЙН. Покрывает кириллицу («онлайн», «онлайни»,
 * «онлайнӣ», «дистанционно»), таджикское «масофавӣ» (дистанционный) и латиницу
 * («online», «onlayn», «onlain»). Адрес сайта shirinsweets.online — не просьба
 * об онлайне, поэтому слово после точки не считается.
 */
const ONLINE_RE =
  /(?<![.\p{L}])(онлайн\p{L}*|online|onlayn|onlain|дистанцион\p{L}*|масофав\p{L}*|аз\s+интернет|через\s+интернет|по\s+интернету)(?!\p{L})/iu;

export function isOnlineRequest(text: string | null | undefined): boolean {
  return !!text && ONLINE_RE.test(text);
}

/**
 * «Запишите меня на онлайн курс» — просьба про ОНЛАЙН, хотя слово «запишите»
 * совпадает с признаком офлайн-записи (ai.ts WANTS_OFFLINE_RE). Такому человеку
 * карточка очного курса не нужна. Если же в сообщении есть и «офлайн»
 * («онлайн не хочу, офлайн доред?»), интерес к очному курсу настоящий.
 */
const MENTIONS_OFFLINE = /офлайн|оффлайн|offline|oflayn/iu;
export function asksOnlineNotOffline(text: string | null | undefined): boolean {
  return isOnlineRequest(text) && !MENTIONS_OFFLINE.test(text ?? "");
}

/**
 * ОТМЕНА ИЛИ СОМНЕНИЕ ПО ОФЛАЙН-ЗАПИСИ («передумала», «не смогу прийти»,
 * «дорого», «не уверена»). На это молчать нельзя (владелец 09.11.2026):
 * человек уходит, и единственный шанс удержать его — ответить сейчас. Сомнения
 * ловит уже существующий признак (ai/testimonials.ts::hasDoubtSignal), здесь
 * только слова отмены, которых там нет.
 *
 * «Нет денег», «бе пул» сюда нарочно не входят: это «пустите бесплатно», на
 * которое бот по решению владельца молчит везде (offTopicGuard, FREELOADER) —
 * снятие паузы здесь всё равно упёрлось бы в то молчание.
 */
const CANCEL_RE =
  /(отмен\p{L}*|передума\p{L}*|не\s+смогу|не\s+приду|не\s+получится\s+прий|не\s+буду\s+(записыв|ходить|учиться)|бекор\p{L}*|фикрам(ро)?\s+дигар|наметавонам|намеоям)/iu;

export function isCancelOrDoubt(text: string | null | undefined): boolean {
  return !!text && (CANCEL_RE.test(text) || hasDoubtSignal(text));
}

export type OfflineHandoffVerdict = "none" | "silent" | "resume";

/**
 * Решение по входящему сообщению человека в состоянии «передано Ширин».
 *  none   — состояния нет, рубильник выключен, чат на САЙТЕ (там Ширин нет —
 *           молчать некому передать) или человек отменяет/сомневается:
 *           обычный путь, отметка остаётся.
 *  silent — бот молчит, разговор ведёт Ширин (Instagram; если она не ответит,
 *           сторож unansweredWatch.ts напомнит ей в Telegram).
 *  resume — человек попросил онлайн (или уже купил): отметка снята, бот снова
 *           отвечает, начиная с этого сообщения.
 */
export async function offlineHandoffGate(
  contact: Pick<Contact, "id" | "offlineHandoffAt" | "paid"> & { channel?: string },
  text: string | null | undefined,
): Promise<OfflineHandoffVerdict> {
  if (!contact.offlineHandoffAt) return "none";
  if (!(await offlineHandoffEnabled())) return "none";
  if (contact.paid || isOnlineRequest(text)) {
    await leaveOfflineHandoff(contact.id);
    return "resume";
  }
  // Чат на сайте: Ширин его не видит, «передать» разговор некому.
  if (contact.channel === "WEB") return "none";
  if (isCancelOrDoubt(text)) return "none";
  return "silent";
}

/** Молчит ли бот сейчас из-за «офлайн: передано Ширин» — для сторожа (без побочных эффектов). */
export async function offlineHandoffSilences(
  contact: Pick<Contact, "offlineHandoffAt" | "paid"> & { channel?: string },
): Promise<boolean> {
  if (!contact.offlineHandoffAt || contact.paid || contact.channel === "WEB") return false;
  return offlineHandoffEnabled();
}

/** Поставить отметку после отправленной карточки. */
export async function enterOfflineHandoff(contactId: string): Promise<void> {
  await prisma.contact
    .update({ where: { id: contactId }, data: { offlineHandoffAt: new Date() } })
    .catch((err) => logError("offlineHandoff:enter", err));
}

/** Снять отметку — человек вернулся к онлайну. */
export async function leaveOfflineHandoff(contactId: string): Promise<void> {
  await prisma.contact
    .update({ where: { id: contactId }, data: { offlineHandoffAt: null } })
    .catch((err) => logError("offlineHandoff:leave", err));
}
