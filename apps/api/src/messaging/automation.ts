import { AsyncLocalStorage } from "node:async_hooks";
import { getSetting, prisma } from "../db.js";

// Permission is scoped to one outbound operation, never to the whole webhook.
// An ordinary AI task cannot inherit the funnel's exemption after it returns.
const permission = new AsyncLocalStorage<"funnel" | "human">();
export type MessagePurpose = "reply" | "verified_receipt_access" | "human";
const contactPermission = new AsyncLocalStorage<{ contactId: string; purpose: MessagePurpose }>();
const receiptEvidence = new AsyncLocalStorage<{ contactId: string; imageHash: string }>();

export function currentReceiptEvidence(): { contactId: string; imageHash: string } | undefined {
  return receiptEvidence.getStore();
}

/** Only the accepted receipt verdict may enter this scope; never a whole AI turn. */
export function withVerifiedReceiptDelivery<T>(contactId: string, imageHash: string, deliver: () => Promise<T>): Promise<T> {
  if (!imageHash) throw new ContactMessagingBlocked("missing receipt evidence");
  return receiptEvidence.run({ contactId, imageHash }, deliver);
}

export class ContactMessagingBlocked extends Error {
  constructor(public readonly reason: string) {
    super(`Contact messaging blocked: ${reason}`);
  }
}

type ContactPolicy = {
  channel?: string;
  personal?: boolean;
  spamBlockedAt?: Date | null;
  whatsappSavedContact?: boolean;
  humanTakenOverAt?: Date | null;
  humanSilencedUntil?: Date | null;
};

/**
 * ПАУЗА ПОСЛЕ ЖИВОГО ОТВЕТА ШИРИН — ВРЕМЕННАЯ (владелец 09.11.2026: «чтобы никто
 * не оставался без ответа»).
 *
 * Раньше одна её реплика из приложения Instagram ставила humanTakenOverAt — и
 * бот молчал с этим человеком НАВСЕГДА, пока владелец не снимет паузу руками.
 * Ширин ответила один раз и ушла — следующий вопрос клиента висел без ответа.
 *
 * Теперь в Instagram и Messenger пауза длится `humanSilenceHours` (по умолчанию
 * 3 часа) от её ПОСЛЕДНЕГО ответа (webhook.ts::handleEcho обновляет отметку на
 * каждом её сообщении). Потом бот снова отвечает на новые сообщения, а сторож
 * unansweredWatch.ts отвечает на то, что пришло во время паузы и осталось без
 * ответа.
 *
 * WhatsApp не трогаем: там пауза ставится вручную кнопкой в панели и снимается
 * тоже вручную (whatsapp/routes.ts). Канал не передан — считаем по-старому,
 * навсегда: защита по умолчанию — лучше промолчать, чем влезть в чужой разговор.
 *
 * Одна дверь: и webhook.ts, и дверь отправки (assertContactMessagingAllowed), и
 * очередь повторов (aiReplyRetry.ts), и сторож читают паузу только отсюда.
 */
export const HUMAN_SILENCE_HOURS_SETTING = "humanSilenceHours";
export const DEFAULT_HUMAN_SILENCE_HOURS = 3;
/** Потолок — неделя: больше уже не «пауза», а ручная отметка «личный». */
const MAX_HUMAN_SILENCE_HOURS = 24 * 7;
let humanSilenceMs = DEFAULT_HUMAN_SILENCE_HOURS * 3_600_000;

/** Прочитать настройку и запомнить. Вызывается дверью отправки перед КАЖДОЙ
 *  отправкой, вебхуком на каждом входящем и сторожем на каждом тике — поэтому
 *  синхронная проверка ниже видит свежее значение. Мусор в настройке — 3 часа. */
export async function loadHumanSilenceMs(): Promise<number> {
  const raw = Number((await getSetting(HUMAN_SILENCE_HOURS_SETTING))?.trim().replace(",", "."));
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HUMAN_SILENCE_HOURS) : DEFAULT_HUMAN_SILENCE_HOURS;
  humanSilenceMs = Math.round(hours * 3_600_000);
  return humanSilenceMs;
}

/** Только для тестов. */
export function resetHumanSilenceMs(): void {
  humanSilenceMs = DEFAULT_HUMAN_SILENCE_HOURS * 3_600_000;
}

/** Когда кончается пауза после живого ответа; null — паузы нет; Infinity — навсегда (WhatsApp). */
export function humanTakeoverEndsAt(contact: ContactPolicy, silenceMs = humanSilenceMs): number | null {
  if (!contact.humanTakenOverAt) return null;
  if (contact.channel !== "INSTAGRAM" && contact.channel !== "MESSENGER") return Infinity;
  return contact.humanTakenOverAt.getTime() + silenceMs;
}

/** Ширин ведёт разговор сама прямо сейчас (пауза после её ответа ещё не кончилась). */
export function humanTakeoverActive(contact: ContactPolicy, now = Date.now(), silenceMs = humanSilenceMs): boolean {
  const ends = humanTakeoverEndsAt(contact, silenceMs);
  return ends !== null && now < ends;
}

/** Любая «человеческая» тишина: её живой ответ или просьба клиента позвать человека. */
export function humanSilenceActive(contact: ContactPolicy, now = Date.now()): boolean {
  return humanTakeoverActive(contact, now) || Boolean(contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > now);
}

/**
 * С ЭТИМ ЧЕЛОВЕКОМ ШИРИН ХОТЬ РАЗ ГОВОРИЛА САМА — НАПОМИНАНИЙ НЕ ШЛЁМ НИКОГДА
 * (решение владельца 09.11.2026). Пауза после её ответа временная (3 часа), но
 * напоминания — «вступите в группу», «завтра офлайн-курс», «как первый урок?»,
 * догоняющие — поверх её живого разговора неуместны навсегда, а не на 3 часа.
 * Ответы бота на вопросы клиента это НЕ касается: на вопрос отвечаем всегда.
 *
 * Признак: отметка паузы когда-либо стояла (humanTakenOverAt) или в истории
 * есть её исходящее (byHuman). Одна дверь для всех рассылок-напоминаний;
 * сторож в CI (tests/unit/humanSilenceTemporary.test.ts) проверяет, что каждая
 * из них её вызывает. Сбой базы — считаем «говорила»: лучше не напомнить.
 */
export async function everTalkedWithShirin(contact: { id: string; humanTakenOverAt?: Date | null }): Promise<boolean> {
  if (contact.humanTakenOverAt) return true;
  try {
    const human = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: "OUT", byHuman: true },
      select: { id: true },
    });
    return Boolean(human);
  } catch {
    return true;
  }
}

export function contactAutomationBlocked(contact: ContactPolicy, purpose: MessagePurpose = "reply"): boolean {
  if (purpose === "human") return false;
  if (contact.personal || contact.spamBlockedAt || contact.whatsappSavedContact) return true;
  return purpose !== "verified_receipt_access" && humanSilenceActive(contact);
}

/**
 * WHATSAPP: «БОТ МОЛЧИТ, НО ЧЕКИ СЧИТАЕТ» (владелец 13.11.2026).
 *
 * Раньше, чтобы бот не болтал в WhatsApp, владелец ставил мост на паузу — и мост
 * выбрасывал ВСЕ входящие, чеки тоже: оплаты из WhatsApp не считались, ссылка не
 * уходила. Теперь мост остаётся включённым, а этот рубильник глушит в WhatsApp
 * любые сообщения бота (ответы ИИ, напоминания, вложения), кроме ссылки после
 * проверенного чека (verified_receipt_access) и сообщений самой Ширин.
 * Одна дверь: проверка в assertContactMessagingAllowed, её вызывает каждая отправка.
 */
export const WHATSAPP_RECEIPTS_ONLY_SETTING = "whatsappReceiptsOnly";
export async function whatsappReceiptsOnly(): Promise<boolean> {
  return (await getSetting(WHATSAPP_RECEIPTS_ONLY_SETTING)) === "true";
}

/** Reload immediately before each network operation, including transport retries. */
export async function assertContactMessagingAllowed(contactId: string, purpose: MessagePurpose = "reply"): Promise<void> {
  if (purpose === "human" || permission.getStore() === "human") return;
  if (purpose === "verified_receipt_access" && currentReceiptEvidence()?.contactId !== contactId) {
    throw new ContactMessagingBlocked("unverified receipt scope");
  }
  await loadHumanSilenceMs();
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) throw new ContactMessagingBlocked("missing contact");
  if (contactAutomationBlocked(contact, purpose)) throw new ContactMessagingBlocked("contact policy");
  if (purpose === "reply" && contact.channel === "WHATSAPP" && (await whatsappReceiptsOnly())) {
    throw new ContactMessagingBlocked("whatsapp receipts only");
  }
}

export function withContactMessaging<T>(contactId: string, purpose: MessagePurpose, send: () => Promise<T>): Promise<T> {
  return contactPermission.run({ contactId, purpose }, send);
}

export async function isBotFrozen(): Promise<boolean> {
  return (await getSetting("botFrozen")) === "true";
}

export async function assertAutomationAllowed(): Promise<void> {
  if (await isBotFrozen()) throw new Error("Bot automation is frozen");
}

export async function assertMessagingAllowed(): Promise<void> {
  if (!permission.getStore()) await assertAutomationAllowed();
  const scope = contactPermission.getStore();
  if (scope) await assertContactMessagingAllowed(scope.contactId, scope.purpose);
}

export function withMessagingPermission<T>(kind: "funnel" | "human", send: () => Promise<T>): Promise<T> {
  return permission.run(kind, send);
}
