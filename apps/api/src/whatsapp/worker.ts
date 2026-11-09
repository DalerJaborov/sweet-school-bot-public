import { prisma, getSetting, logError } from "../db.js";
import { aiReply, rescueImage, type RescuedImage } from "../ai.js";
import { bridgeRequest, bridgeEventSchema, whatsappConfigured, whatsappMessageId, type BridgeEvent, type ContactStatus } from "./client.js";
import { withWhatsAppTurn } from "./context.js";
import type { Attachment } from "../ai/media.js";
import { saveOwnerMedia } from "../upload.js";
import { isListedPersonal } from "../ai/personalList.js";
import { withTakeoverOverride } from "../messaging/automation.js";
import { resolveTakeover } from "../ai/ownerTakeover.js";
import { attentionError, classifyAttention } from "./attention.js";
import { rememberOwnerReply } from "../ai/styleLearning.js";
import { recordAdReferral } from "../metaConversions.js";

let ingesting = false;
const processing = new Set<string>();
export async function ingestWhatsAppEvents(): Promise<void> {
  if (!whatsappConfigured() || ingesting) return;
  ingesting = true;
  try {
    const batch = await bridgeRequest<{ events: unknown[] }>("/events");
    for (const raw of batch.events) {
      const e = bridgeEventSchema.parse(raw);
      const id = `${e.accountId}:${e.id}`;
      const externalContact = `${e.accountId}:${e.chatId}`;
      const contact = await prisma.contact.upsert({
        where: { channel_igUserId: { channel: "WHATSAPP", igUserId: externalContact } },
        create: { channel: "WHATSAPP", igUserId: externalContact }, update: {},
      });
      await prisma.$transaction(async tx => {
        await tx.whatsAppInbox.upsert({ where: { id }, create: {
          id, accountId: e.accountId, chatId: e.chatId, contactId: contact.id,
          kind: e.type, replyToId: e.messageId, payload: JSON.stringify(e), status: e.type === "human" ? "done" : "pending",
        }, update: {} });
        await tx.message.upsert({ where: { mid: whatsappMessageId(e.accountId, e.messageId) }, create: {
          contactId: contact.id, mid: whatsappMessageId(e.accountId, e.messageId), direction: e.type === "human" ? "OUT" : "IN",
          text: e.text || null, byHuman: e.type === "human", createdAt: new Date(e.timestamp),
        }, update: {} });
        if (e.type === "human") await tx.contact.update({ where: { id: contact.id }, data: {
          humanTakenOverAt: new Date(e.timestamp), humanTakeoverMid: whatsappMessageId(e.accountId, e.messageId),
        } });
      });
      if (e.type === "human" && e.text.trim() && !contact.personal && !contact.whatsappSavedContact && !contact.spamBlockedAt) {
        // Не ждём: проверка идёт через паузу (см. learnFromOwner), а приём событий стоять не должен.
        scheduleLearnFromOwner(contact.id, whatsappMessageId(e.accountId, e.messageId), e.text, new Date(e.timestamp));
      }
      if (e.type === "incoming" && e.ad) {
        await recordAdReferral(contact.id, { adId: e.ad.sourceId, ctwaClid: e.ad.ctwaClid, source: e.ad.sourceType ?? "whatsapp_ad" })
          .catch((err) => logError("whatsapp:adReferral", err));
      }
      await bridgeRequest(`/events/${encodeURIComponent(e.id)}/ack`, {});
    }
  } finally { ingesting = false; }
}

/** Пауза перед проверкой «это правда Ширин»: событие моста может прийти раньше, чем
 *  бот запишет mid своего же сообщения (recordOutgoingMessage снимет ложную пометку
 *  byHuman). Тот же приём, что в Instagram (webhook.ts::handleEcho, 20 секунд). */
export const OWNER_LEARN_DELAY_MS = 20_000;
/** Вопрос клиента старше суток — уже не тот разговор: в пару его не берём. */
const OWNER_LEARN_WINDOW_MS = 24 * 3_600_000;

function scheduleLearnFromOwner(contactId: string, mid: string, ownerText: string, ownerAt: Date): void {
  setTimeout(() => void learnFromOwner(contactId, mid, ownerText, ownerAt), OWNER_LEARN_DELAY_MS);
}

/**
 * ЖИВОЕ ОБУЧЕНИЕ НА WHATSAPP. Ширин ответила сама со своего телефона — её фраза
 * становится образцом манеры (ai/styleLearning.ts), как в Instagram (webhook.ts).
 * До 08.11.2026 WhatsApp-ответы хозяйки в образцы не попадали вовсе, и бот учился
 * только на старой переписке Instagram. Строка должна остаться «человеческой»:
 * если это эхо ответа самого бота (строка уже записана как его), не учимся.
 */
async function learnFromOwner(contactId: string, mid: string, ownerText: string, ownerAt: Date): Promise<void> {
  try {
    const row = await prisma.message.findUnique({ where: { mid }, select: { byHuman: true } });
    if (!row?.byHuman) return;
    const lastIn = await prisma.message.findFirst({
      where: {
        contactId, direction: "IN", text: { not: null }, payload: null,
        createdAt: { lte: ownerAt, gte: new Date(ownerAt.getTime() - OWNER_LEARN_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    // Чат, где пишет только Ширин (родным, знакомым — её личный номер), — не
    // разговор с клиентом: такие фразы в образцы манеры не берём.
    if (!lastIn?.text) return;
    await rememberOwnerReply(lastIn.text, ownerText, "TAKEOVER", undefined, contactId);
  } catch (err) {
    logError("whatsapp:learnFromOwner", err);
  }
}

export async function processInbox(id: string): Promise<void> {
  const row = await prisma.whatsAppInbox.findUnique({ where: { id } });
  if (!row?.contactId) return;
  const event = bridgeEventSchema.parse(JSON.parse(row.payload));
  const payload = JSON.parse(row.payload) as BridgeEvent & { imageHash?: string; imageUrl?: string; queuedId?: string };
  const contact = await prisma.contact.findUnique({ where: { id: row.contactId } });
  if (!contact) return;
  const connection = await bridgeRequest<{ accountId?: string; enabled?: boolean; contactsReady?: boolean }>("/status");
  if (connection.accountId !== row.accountId) throw attentionError("other_account", "Подключён другой аккаунт WhatsApp");
  if (!connection.enabled || !connection.contactsReady) throw Object.assign(new Error("WhatsApp на паузе"), { code: "WhatsAppPaused" });
  const check = await bridgeRequest<ContactStatus>(`/contact-status?chatId=${encodeURIComponent(row.chatId)}`);
  if (check.isMyContact || check.blocked) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappSavedContact: true } });
    await prisma.whatsAppInbox.update({ where: { id }, data: { status: "blocked", payload: JSON.stringify({ ...payload, media: undefined }) } });
    return;
  }
  if (!check.identityResolved) throw attentionError("contact_check", "Не удалось проверить контакт WhatsApp");
  const phone = check.aliases?.find(alias => /^\d{7,15}@c\.us$/.test(alias))?.split("@")[0];
  if (phone && !contact.name) await prisma.contact.update({ where: { id: contact.id }, data: { name: `+${phone}` } });
  if (phone && !contact.personal && (await isListedPersonal(phone))) {
    await prisma.contact.update({ where: { id: contact.id }, data: { personal: true, personalReason: "Список личных контактов (добавлен владельцем)" } });
    contact.personal = true;
  }
  const stamp = event.timestamp;
  if (Date.now() - stamp > 86400000 || stamp > Date.now() + 60000) {
    await prisma.whatsAppInbox.update({ where: { id }, data: { status: "expired", payload: JSON.stringify({ ...payload, media: undefined }) } });
    return;
  }
  if (contact.personal || contact.spamBlockedAt || contact.whatsappSavedContact) {
    await prisma.whatsAppInbox.update({ where: { id }, data: { status: "blocked" } }); return;
  }
  if (check.takenOver && !contact.humanTakenOverAt) {
    await prisma.contact.update({ where: { id: contact.id }, data: { humanTakenOverAt: new Date() } });
  }
  if (event.mediaUnavailable) throw attentionError("media_unavailable", `Вложение WhatsApp недоступно: ${event.mediaUnavailable}; нужен ответ хозяйки`);
  if (!event.text.trim() && !event.media) throw attentionError("empty", "Пустое сообщение WhatsApp не передаётся ИИ");
  await withWhatsAppTurn({ inboxId: id, contactId: contact.id, accountId: row.accountId, chatId: row.chatId, messageId: event.messageId }, async () => {
    const images: RescuedImage[] = [];
    const attachments: Attachment[] = [];
    if (event.media?.mimeType.startsWith("image/")) {
      const buffer = Buffer.from(event.media.data, "base64");
      if (buffer.length > 8 * 1024 * 1024) throw attentionError("too_big", "Слишком большое вложение");
      const image = payload.imageHash && payload.imageUrl
        ? { buffer, mimeType: event.media.mimeType, hash: payload.imageHash, url: payload.imageUrl, queuedId: payload.queuedId ?? null }
        : await rescueImage(contact, buffer, event.media.mimeType);
      if (!image.url || !image.queuedId) throw attentionError("save_failed", "Не удалось сохранить чек");
      images.push(image); attachments.push({ url: image.url, kind: "image" });
      payload.imageHash = image.hash; payload.imageUrl = image.url; payload.queuedId = image.queuedId;
      await prisma.whatsAppInbox.update({ where: { id }, data: { payload: JSON.stringify(payload) } });
      await prisma.message.update({ where: { mid: whatsappMessageId(event.accountId, event.messageId) }, data: { imageUrl: image.url } });
    }
    // Owner takeover suppresses ordinary conversation but image intake remains
    // durable: the existing verified receipt worker can deliver paid access.
    let safeAnswer = false;
    let fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
    if (!fresh) return;
    if (fresh.humanTakenOverAt || check.takenOver) {
      // Умный перехват (ai/ownerTakeover.ts): пока Ширин на связи — откладываем, ушла — отвечаем.
      const verdict = await resolveTakeover(fresh, { text: event.text, at: new Date(event.timestamp) });
      if (verdict.action === "hold") {
        if (verdict.until) {
          // Строка вернётся в очередь тиком dispatchWhatsAppInbox и будет решена заново.
          await prisma.whatsAppInbox.update({ where: { id }, data: { status: "held", attempts: { decrement: 1 } } });
        }
        return;
      }
      safeAnswer = verdict.why === "safe_intent";
      // Мост сам запрещает отправку после ручной реплики — снимаем его флаг перед ответом.
      if (check.takenOver) await bridgeRequest("/takeover/reset", { chatId: row.chatId });
      fresh = (await prisma.contact.findUnique({ where: { id: contact.id } })) ?? fresh;
    }
    if (event.media && !event.media.mimeType.startsWith("image/")) {
      if (!event.media.mimeType.startsWith("audio/")) throw attentionError("attachment", "Вложение требует ответа хозяйки");
      const buffer = Buffer.from(event.media.data, "base64");
      if (buffer.length > 8 * 1024 * 1024) throw attentionError("too_big", "Слишком большое голосовое");
      const url = saveOwnerMedia(buffer, event.media.mimeType);
      if (!url) throw attentionError("save_failed", "Не удалось сохранить голосовое");
      attachments.push({ url, kind: "audio" });
    }
    // Безопасный запрос: пауза хозяйки остаётся, но разовое разрешение даёт ответить (ai/ownerTakeover.ts).
    if (safeAnswer) await withTakeoverOverride(fresh.id, () => aiReply(fresh!, event.text, attachments, images));
    else await aiReply(fresh, event.text, attachments, images);
  });
  // updateMany + условие: если шлюз «не по делу» уже перевёл строку в attention («нужен человек»),
  // статус done её не затрёт.
  await prisma.whatsAppInbox.updateMany({ where: { id, status: "processing" }, data: { status: "done", payload: JSON.stringify({ ...payload, media: undefined }) } });
  await prisma.whatsAppInbox.updateMany({ where: { id, status: "attention" }, data: { payload: JSON.stringify({ ...payload, media: undefined }) } });
}

export async function dispatchWhatsAppInbox(): Promise<void> {
  if (!whatsappConfigured() || await getSetting("botFrozen") === "true") return;
  const connection = await bridgeRequest<{ enabled?: boolean; contactsReady?: boolean }>("/status");
  if (!connection.enabled || !connection.contactsReady) return;
  // Отложенные умным перехватом: раз в минуту решаем заново (ответили руками — строка закроется сама).
  await prisma.whatsAppInbox.updateMany({ where: { status: "held", updatedAt: { lte: new Date(Date.now() - 60_000) } }, data: { status: "pending" } });
  const rows = await prisma.whatsAppInbox.findMany({
    where: { status: "pending", updatedAt: { lte: new Date(Date.now() - 2500) } }, orderBy: { createdAt: "asc" }, take: 30,
  });
  for (const row of rows) {
    const chatKey = `${row.accountId}:${row.chatId}`;
    if (processing.size >= 4 || processing.has(chatKey)) continue;
    processing.add(chatKey);
    void (async () => {
      const claim = await prisma.whatsAppInbox.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "processing", attempts: { increment: 1 } } });
      if (!claim.count) return;
      try { await processInbox(row.id); }
      catch (error) {
        if ((error as { code?: string })?.code === "WhatsAppPaused") {
          await prisma.whatsAppInbox.update({ where: { id: row.id }, data: { status: "pending", attempts: { decrement: 1 } } });
          return;
        }
        const retryable = isWhatsAppGenerationRetry(error) && row.attempts < 2;
        await prisma.whatsAppInbox.update({ where: { id: row.id }, data: retryable ? { status: "pending" } : { status: "attention", attentionReason: classifyAttention(error) } });
        logError("whatsapp:inbox", error);
      }
    })().catch(e => logError("whatsapp:worker", e)).finally(() => processing.delete(chatKey));
  }
}

export function isWhatsAppGenerationRetry(error: unknown): boolean {
  return (error as { code?: string })?.code === "WhatsAppGenerationRetry" ||
    (error instanceof Error && error.message.startsWith("WhatsAppGenerationRetry:"));
}

export function startWhatsAppWorker(): void {
  if (!whatsappConfigured()) return;
  // A process interrupted after dispatch may already have sent something.
  // Never blindly replay such a turn on restart.
  void prisma.whatsAppInbox.updateMany({ where: { status: "processing" }, data: { status: "attention", attentionReason: "restarted" } }).catch(e => logError("whatsapp:recover", e));
  setInterval(() => { void ingestWhatsAppEvents().catch(e => logError("whatsapp:connection", e)); }, 1000).unref();
  setInterval(() => { void dispatchWhatsAppInbox().catch(e => logError("whatsapp:queue", e)); }, 1000).unref();
}
