import { prisma, getSetting, setSetting, logError, recordOutgoingMessage } from "./db.js";
import { sendToContact } from "./messaging/send.js";
import {
  contactAutomationBlocked,
  everTalkedWithShirin,
  isBotFrozen,
  loadHumanSilenceMs,
  whatsappReceiptsOnly,
} from "./messaging/automation.js";
import { contactLanguage } from "./ai/contactLanguage.js";
import { defersPayment } from "./ai/paymentIntent.js";
import { mentionsPaymentPhone } from "./ai/repeatGuard.js";
import { paymentLine } from "./ai/prompts.js";
import { getSalesTexts } from "./services/salesTextsService.js";
import { isTrivialMessage } from "./trivialMessage.js";

/**
 * НАПОМИНАНИЕ «ЗАВТРА ПЕРЕВЕДУ» (владелец 16.11.2026: «Да, исправляй»).
 *
 * Разбор 16.11: за три дня ~8 человек получили номер карты, написали «пагоҳ пулро
 * мефиристам», «завтра переведу», «с мужем посоветуюсь» и пропали. Напоминаний
 * не было вовсе (FollowUp выключены решением 21.08 и про другое: «прошёл воронку»).
 *
 * Правило: человек не купил, номер карты ему уже уходил, и ПОСЛЕДНЕЕ его сообщение
 * — отсрочка оплаты. Через ~20 часов одно тёплое напоминание с номером. Строго
 * внутри 24-часового окна Instagram от его последнего входящего: шлём между 20 и
 * 23 часами (час запаса); закрывается раньше — не шлём совсем.
 *
 * Один раз на эпизод: строка PaymentReminder на входящее-отсрочку (уникальна), и не
 * чаще раза в REMINDER_COOLDOWN_DAYS на человека. Не шлём: оплатил или прислал чек,
 * после отсрочки он писал ещё (тогда это уже другой разговор), личный/спам/пауза
 * Ширин/«просил человека», Ширин хоть раз говорила с ним сама (решение 09.11,
 * everTalkedWithShirin), бот выключен или на паузе, WhatsApp в режиме «только чеки»,
 * чат на сайте (написать первым туда нельзя).
 *
 * Рубильник `paymentReminderEnabled` — по умолчанию ВКЛЮЧЁН, "false" выключает.
 * Текст — в настройках `paymentReminderTextTg` / `paymentReminderTextRu`: при первом
 * чтении туда записывается заготовка, дальше бот берёт только настройку (пусто —
 * не шлём). `{реквизиты}` — номер, получатель и банки из «Тексты и цены».
 */
export const PAYMENT_REMINDER_SETTING = "paymentReminderEnabled";
export const PAYMENT_REMINDER_TEXT_KEYS = { tg: "paymentReminderTextTg", ru: "paymentReminderTextRu" } as const;

/** Заготовки: пишутся в настройку один раз, дальше их правит владелец. Без тире и списков, на «шумо». */
export const PAYMENT_REMINDER_SEED = {
  tg: "Ассалому алейкум! Хостам ёдрас кунам: агар тайёр бошед, рақами корт {реквизиты}. Баъди пардохт чекро ҳамин ҷо фиристед, ссылкаи дарсҳо зуд меояд.",
  ru: "Здравствуйте! Напоминаю на всякий случай: когда будете готовы, номер карты {реквизиты}. После оплаты пришлите чек сюда, ссылка на уроки придёт сразу.",
} as const;

const HOUR = 3_600_000;
/** Через сколько после последнего сообщения человека напоминаем. */
export const REMIND_AFTER_HOURS = 20;
/** Позже этого не шлём: окно Meta 24 часа, час запаса на часы и очередь. */
export const REMIND_BEFORE_HOURS = 23;
/** Последнее сообщение — «ок» после отсрочки: смотрим отсрочку до него в этом окне. */
const TRIVIAL_TAIL_MS = 60 * 60_000;
/** Номер должен был уходить человеку не раньше этого до отсрочки. */
const NUMBER_SENT_WITHIN_MS = 72 * HOUR;
/** Не чаще одного напоминания на человека за столько дней. */
const REMINDER_COOLDOWN_DAYS = 7;
/** Про офлайн-курс номер не шлём: туда записывает Ширин. */
const OFFLINE = /офлайн|оффлайн|offline|дар\s+назди|назди\s+ман|очн/iu;

async function reminderEnabled(): Promise<boolean> {
  if ((await getSetting(PAYMENT_REMINDER_SETTING))?.trim() === "false") return false;
  if (await isBotFrozen()) return false;
  // «Бот выключен» — консультант не отвечает людям: напоминать тоже не время.
  return (await getSetting("aiEnabled"))?.trim() === "true";
}

/** Текст из настройки; настройки ещё нет — записываем заготовку и берём её. */
export async function reminderTemplate(language: "tg" | "ru"): Promise<string> {
  const key = PAYMENT_REMINDER_TEXT_KEYS[language];
  const raw = await getSetting(key);
  if (raw !== null) return raw.trim();
  await setSetting(key, PAYMENT_REMINDER_SEED[language]);
  return PAYMENT_REMINDER_SEED[language];
}

type Decision = { state: "SENT" | "SKIPPED"; reason?: string };

async function record(contactId: string, triggerMessageId: string, d: Decision): Promise<boolean> {
  try {
    await prisma.paymentReminder.create({
      data: { contactId, triggerMessageId, state: d.state, reason: d.reason?.slice(0, 200) ?? null },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") logError("paymentReminder:record", err);
    return false; // уже решали по этой отсрочке (другой тик или параллельный процесс)
  }
}

/** Почему не шлём этому человеку (null — можно). Проверки дешёвые первыми. */
async function skipReason(
  contact: NonNullable<Awaited<ReturnType<typeof prisma.contact.findUnique>>>,
  trigger: { id: string; createdAt: Date },
  phone: string,
): Promise<string | null> {
  if (contact.channel === "WEB") return "web_chat";
  if (contact.channel === "WHATSAPP" && (await whatsappReceiptsOnly())) return "whatsapp_receipts_only";
  if (contactAutomationBlocked(contact)) return "contact_policy";
  if (contact.paid) return "paid";
  if (await everTalkedWithShirin(contact)) return "talked_with_shirin";
  const [purchases, receipts, laterOut, cooldown, numberOut] = await Promise.all([
    prisma.purchase.count({ where: { contactId: contact.id, revokedAt: null } }),
    prisma.receiptCheck.count({ where: { contactId: contact.id, createdAt: { gte: new Date(trigger.createdAt.getTime() - 48 * HOUR) } } }),
    prisma.message.count({ where: { contactId: contact.id, direction: "OUT", byHuman: true, createdAt: { gt: trigger.createdAt } } }),
    prisma.paymentReminder.count({
      where: { contactId: contact.id, state: "SENT", createdAt: { gte: new Date(Date.now() - REMINDER_COOLDOWN_DAYS * 24 * HOUR) } },
    }),
    prisma.message.findMany({
      where: {
        contactId: contact.id,
        direction: "OUT",
        text: { not: null },
        createdAt: { gte: new Date(trigger.createdAt.getTime() - NUMBER_SENT_WITHIN_MS), lte: trigger.createdAt },
      },
      select: { text: true },
      take: 50,
    }),
  ]);
  if ((purchases ?? 0) > 0) return "paid";
  if ((receipts ?? 0) > 0) return "receipt";
  if ((laterOut ?? 0) > 0) return "talked_after";
  if ((cooldown ?? 0) > 0) return "cooldown";
  if (!(numberOut ?? []).some((m) => mentionsPaymentPhone(m.text ?? "", phone))) return "no_number_before";
  return null;
}

/**
 * Отсрочка, на которую напоминаем: последнее входящее человека — или, если оно
 * пустяк («ок», «рахмат»), отсрочка прямо перед ним.
 */
async function deferralTrigger(contactId: string): Promise<{ id: string; text: string; createdAt: Date; lastInAt: Date } | null> {
  const last = await prisma.message.findMany({
    where: { contactId, direction: "IN" },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: { id: true, text: true, createdAt: true },
  });
  const latest = last?.[0];
  if (!latest) return null;
  for (const m of last) {
    if (latest.createdAt.getTime() - m.createdAt.getTime() > TRIVIAL_TAIL_MS) break;
    const text = m.text ?? "";
    if (defersPayment(text) && !OFFLINE.test(text)) return { id: m.id, text, createdAt: m.createdAt, lastInAt: latest.createdAt };
    if (!isTrivialMessage(text)) break; // настоящее сообщение не про отсрочку — разговор ушёл дальше
  }
  return null;
}

/** Фоновый тик (index.ts, раз в 10 минут). Возвращает, сколько напоминаний ушло. */
export async function runPaymentReminders(now = Date.now()): Promise<number> {
  if (!(await reminderEnabled())) return 0;
  await loadHumanSilenceMs();
  // Кандидаты: те, чьё ПОСЛЕДНЕЕ входящее легло 20–23 часа назад.
  const recent = await prisma.message.findMany({
    where: {
      direction: "IN",
      createdAt: { gte: new Date(now - REMIND_BEFORE_HOURS * HOUR), lte: new Date(now - REMIND_AFTER_HOURS * HOUR) },
    },
    orderBy: { createdAt: "desc" },
    select: { contactId: true },
    take: 1000,
  });
  const contactIds = [...new Set((recent ?? []).map((m) => m.contactId))];
  if (contactIds.length === 0) return 0;
  const texts = await getSalesTexts();
  let sent = 0;
  for (const contactId of contactIds) {
    try {
      const trigger = await deferralTrigger(contactId);
      if (!trigger) continue;
      const sinceLastIn = now - trigger.lastInAt.getTime();
      // Человек писал позже окна — ждём следующих тиков; окно Meta уже закрывается — не шлём.
      if (sinceLastIn < REMIND_AFTER_HOURS * HOUR || sinceLastIn > REMIND_BEFORE_HOURS * HOUR) continue;
      if (await prisma.paymentReminder.findUnique({ where: { triggerMessageId: trigger.id } })) continue;
      if (!(await reminderEnabled())) return sent; // выключили посреди тика
      const contact = await prisma.contact.findUnique({ where: { id: contactId } });
      if (!contact) continue;
      const reason = await skipReason(contact, trigger, texts.paymentPhone);
      if (reason) {
        await record(contactId, trigger.id, { state: "SKIPPED", reason });
        continue;
      }
      const language = (await contactLanguage(contactId, trigger.text)) === "tg" ? "tg" : "ru";
      const template = await reminderTemplate(language);
      if (!template) {
        await record(contactId, trigger.id, { state: "SKIPPED", reason: "no_text" });
        continue;
      }
      const message = template.replace(/\{\s*(реквизиты|requisites)\s*\}/giu, paymentLine(texts));
      // Сначала строка (она же замок от второго тика), потом отправка.
      if (!(await record(contactId, trigger.id, { state: "SENT" }))) continue;
      try {
        const mid = await sendToContact(contact, message);
        await recordOutgoingMessage(contactId, message, mid);
        if (mid) sent += 1;
        else await prisma.paymentReminder.update({ where: { triggerMessageId: trigger.id }, data: { state: "SKIPPED", reason: "filtered_empty" } });
      } catch (err) {
        logError("paymentReminder:send", err);
        await prisma.paymentReminder
          .update({ where: { triggerMessageId: trigger.id }, data: { state: "FAILED", reason: String((err as Error)?.message ?? err).slice(0, 200) } })
          .catch((e) => logError("paymentReminder:markFailed", e));
      }
    } catch (err) {
      logError("paymentReminder:contact", err);
    }
  }
  return sent;
}
