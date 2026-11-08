import { AsyncLocalStorage } from "node:async_hooks";
import { getSetting, prisma } from "../db.js";

// Permission is scoped to one outbound operation, never to the whole webhook.
// An ordinary AI task cannot inherit the funnel's exemption after it returns.
const permission = new AsyncLocalStorage<"funnel" | "human">();
export type MessagePurpose = "reply" | "verified_receipt_access" | "human";
const contactPermission = new AsyncLocalStorage<{ contactId: string; purpose: MessagePurpose }>();
const receiptEvidence = new AsyncLocalStorage<{ contactId: string; imageHash: string }>();
// Разовое исключение из «хозяйка ведёт разговор»: безопасный запрос (вернуть доступ,
// «не открывается») обслуживается сразу, но перехват не снимается — Ширин по-прежнему
// на связи. Привязано к одному контакту и одной операции, как и остальные разрешения.
const takeoverOverride = new AsyncLocalStorage<string>();

/** Действует ли разовое разрешение для этого контакта (проверка перед повторным решением внутри цепочки). */
export function takeoverOverrideActive(contactId: string): boolean {
  return takeoverOverride.getStore() === contactId;
}

/** Выполнить `run`, пока бот имеет право ответить этому контакту вопреки паузе хозяйки. */
export function withTakeoverOverride<T>(contactId: string, run: () => Promise<T>): Promise<T> {
  return takeoverOverride.run(contactId, run);
}

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
  id?: string;
  personal?: boolean;
  spamBlockedAt?: Date | null;
  whatsappSavedContact?: boolean;
  humanTakenOverAt?: Date | null;
  humanSilencedUntil?: Date | null;
};

export function contactAutomationBlocked(contact: ContactPolicy, purpose: MessagePurpose = "reply"): boolean {
  if (purpose === "human") return false;
  if (contact.personal || contact.spamBlockedAt || contact.whatsappSavedContact) return true;
  if (contact.id && takeoverOverride.getStore() === contact.id) return false;
  return purpose !== "verified_receipt_access" && Boolean(contact.humanTakenOverAt ||
    (contact.humanSilencedUntil && contact.humanSilencedUntil.getTime() > Date.now()));
}

/** Reload immediately before each network operation, including transport retries. */
export async function assertContactMessagingAllowed(contactId: string, purpose: MessagePurpose = "reply"): Promise<void> {
  if (purpose === "human" || permission.getStore() === "human") return;
  if (purpose === "verified_receipt_access" && currentReceiptEvidence()?.contactId !== contactId) {
    throw new ContactMessagingBlocked("unverified receipt scope");
  }
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) throw new ContactMessagingBlocked("missing contact");
  if (contactAutomationBlocked(contact, purpose)) throw new ContactMessagingBlocked("contact policy");
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
