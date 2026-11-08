import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import type { QuickButton } from "../instagram.js";
import { currentReceiptEvidence, assertMessagingAllowed } from "../messaging/automation.js";
import { bridgeRequest, whatsappMessageId, type ContactStatus } from "./client.js";
import { currentWhatsAppTurn } from "./context.js";

type Recipient = { id: string; igUserId: string; channel: string };
type Purpose = "reply" | "verified_receipt_access" | "human";
// Each accepted receipt scope can deliver multiple course links without reusing
// one operation ID. A fresh replay starts from zero and is caught by the bridge.
const receiptSequences = new WeakMap<object, number>();

async function authorization(contact: Recipient, purpose: Purpose) {
  if (contact.channel !== "WHATSAPP") throw new Error("Не тот канал отправки");
  const active = currentWhatsAppTurn();
  let inboxId: string, chatId: string, messageId: string, accountId: string, sequence: number;
  if (purpose === "verified_receipt_access") {
    const evidence = currentReceiptEvidence();
    if (!evidence || evidence.contactId !== contact.id) throw new Error("Нет подтверждения проверенного чека");
    const rows = await prisma.whatsAppInbox.findMany({
      where: { contactId: contact.id, kind: "incoming", createdAt: { gte: new Date(Date.now() - 86400000) } },
      orderBy: { createdAt: "desc" }, take: 100,
    });
    const source = rows.find(row => {
      try { return JSON.parse(row.payload).imageHash === evidence.imageHash; } catch { return false; }
    });
    if (!source?.replyToId) throw new Error("Не найдено входящее сообщение с этим чеком");
    ({ id: inboxId, chatId, accountId, replyToId: messageId } = source as typeof source & { replyToId: string });
    sequence = receiptSequences.get(evidence) ?? 0;
    receiptSequences.set(evidence, sequence + 1);
  } else {
    if (!active || active.contactId !== contact.id) throw new Error("WhatsApp: разрешены только ответы на новое входящее сообщение");
    ({ inboxId, chatId, accountId, messageId } = active);
    sequence = active.sequence++;
  }
  const state = await bridgeRequest<{ accountId?: string }>("/status");
  if (state.accountId !== accountId) throw new Error("Подключён другой аккаунт WhatsApp");
  const check = await bridgeRequest<ContactStatus>(`/contact-status?chatId=${encodeURIComponent(chatId)}`);
  if (check.isMyContact || check.blocked) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappSavedContact: true } });
    throw new Error("Этому контакту помощник не отвечает");
  }
  if (!check.identityResolved || (check.takenOver && purpose !== "verified_receipt_access")) throw new Error("Автоответ в этом чате остановлен");
  const operationId = createHash("sha256").update(`${inboxId}:${purpose}:${sequence}`).digest("hex");
  return { operationId, chatId, accountId, replyToId: messageId, purpose: purpose === "human" ? "reply" : purpose };
}

export async function sendWhatsAppText(contact: Recipient, text: string, buttons: QuickButton[] = [], purpose: Purpose = "reply"): Promise<string> {
  const auth = await authorization(contact, purpose);
  const plain = buttons.length ? `${text}\n\n${buttons.map(b => b.title).join("\n")}` : text;
  await assertMessagingAllowed();
  const sent = await bridgeRequest<{ messageId: string }>("/send", { ...auth, text: plain });
  return whatsappMessageId(auth.accountId, sent.messageId);
}
export async function sendWhatsAppAttachment(contact: Recipient, mediaUrl: string, mediaType: string, purpose: Purpose = "reply", caption?: string): Promise<string> {
  const auth = await authorization(contact, purpose);
  await assertMessagingAllowed();
  const sent = await bridgeRequest<{ messageId: string }>("/send", { ...auth, mediaUrl, mediaType, ...(caption ? { text: caption } : {}) });
  return whatsappMessageId(auth.accountId, sent.messageId);
}
