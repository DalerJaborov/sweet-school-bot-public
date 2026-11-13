import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const prisma = {
    contact: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    whatsAppInbox: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    message: { upsert: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma, aiReply: vi.fn(), rescueImage: vi.fn(), verifyReceiptsNow: vi.fn(), getSetting: vi.fn() };
});
vi.mock("../../src/db.js", () => ({ prisma: mocks.prisma, getSetting: mocks.getSetting, logError: vi.fn() }));
vi.mock("../../src/ai.js", () => ({ aiReply: mocks.aiReply, rescueImage: mocks.rescueImage, verifyReceiptsNow: mocks.verifyReceiptsNow }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn() }));
vi.mock("../../src/whatsapp/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/whatsapp/client.js")>(), bridgeRequest: vi.fn(), whatsappConfigured: () => true,
}));
import { bridgeEventSchema, bridgeRequest, whatsappMessageId } from "../../src/whatsapp/client.js";
import { dispatchWhatsAppInbox, ingestWhatsAppEvents, isWhatsAppGenerationRetry, processInbox } from "../../src/whatsapp/worker.js";
import { sendWhatsAppText } from "../../src/whatsapp/transport.js";
import { withWhatsAppTurn } from "../../src/whatsapp/context.js";
import { withVerifiedReceiptDelivery, withContactMessaging } from "../../src/messaging/automation.js";
const contact = { id: "contact", igUserId: "account:chat", channel: "WHATSAPP" };
const event = { id: "incoming", messageId: "incoming", accountId: "account", chatId: "chat", type: "incoming", timestamp: Date.now(), text: "Курс?" };
const safe = { blocked: false, isMyContact: false, identityResolved: true, takenOver: false };
const turn = { inboxId: "account:incoming", accountId: "account", chatId: "chat", contactId: "contact", messageId: "incoming" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockReset();
  mocks.prisma.contact.findUnique.mockResolvedValue(contact);
  mocks.prisma.contact.upsert.mockResolvedValue(contact);
  mocks.prisma.whatsAppInbox.findUnique.mockResolvedValue({ id: turn.inboxId, accountId: "account", chatId: "chat", contactId: "contact", payload: JSON.stringify(event) });
  mocks.prisma.$transaction.mockImplementation(fn => fn(mocks.prisma));
  vi.mocked(bridgeRequest).mockImplementation(async path => {
    if (path === "/status") return { accountId: "account", enabled: true, contactsReady: true } as never;
    if (path.startsWith("/contact-status")) return safe as never;
    if (path === "/send") return { messageId: "outgoing" } as never;
    return {} as never;
  });
});
describe("WhatsApp «только чеки» (владелец 13.11.2026)", () => {
  const receiptsOnly = () => mocks.getSetting.mockImplementation(async (key: string) => key === "whatsappReceiptsOnly" ? "true" : undefined);
  it("text is recorded without AI reply and without an owner task", async () => {
    receiptsOnly();
    await processInbox(turn.inboxId);
    expect(mocks.aiReply).not.toHaveBeenCalled();
    expect(mocks.prisma.whatsAppInbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done" }) }));
  });
  it("receipt image is checked at once, no AI reply", async () => {
    receiptsOnly();
    const image = { buffer: Buffer.from("x"), mimeType: "image/jpeg", hash: "h", url: "https://x/r.jpg", queuedId: "q" };
    mocks.rescueImage.mockResolvedValueOnce(image);
    mocks.prisma.whatsAppInbox.findUnique.mockResolvedValueOnce({ ...turn, id: turn.inboxId, payload: JSON.stringify({ ...event, text: "", media: { data: Buffer.from("x").toString("base64"), mimeType: "image/jpeg" } }) });
    await processInbox(turn.inboxId);
    expect(mocks.verifyReceiptsNow).toHaveBeenCalledWith(contact, [image]);
    expect(mocks.aiReply).not.toHaveBeenCalled();
  });
  it("send door blocks an ordinary reply but lets the verified-receipt link through", async () => {
    receiptsOnly();
    await expect(withWhatsAppTurn(turn, () => withContactMessaging(contact.id, "reply", () => sendWhatsAppText(contact, "Ответ")))).rejects.toThrow("receipts only");
    mocks.prisma.whatsAppInbox.findMany.mockResolvedValue([{ id: turn.inboxId, accountId: "account", chatId: "chat", replyToId: "incoming", payload: JSON.stringify({ imageHash: "h" }) }]);
    await expect(withWhatsAppTurn(turn, () => withVerifiedReceiptDelivery(contact.id, "h", () =>
      withContactMessaging(contact.id, "verified_receipt_access", () => sendWhatsAppText(contact, "Ссылка", [], "verified_receipt_access"))))).resolves.toBe("wa:account:outgoing");
  });
  it("switch off: ordinary reply goes as before", async () => {
    await processInbox(turn.inboxId);
    expect(mocks.aiReply).toHaveBeenCalled();
  });
});

describe("WhatsApp bridge contract", () => {
  it("preserves media failure and accepts bridge maximum text; rejects second timestamps", () => {
    const parsed = bridgeEventSchema.parse({ ...event, text: "x".repeat(12000), mediaUnavailable: "download_failed", takenOver: true });
    expect(parsed.mediaUnavailable).toBe("download_failed");
    expect(bridgeEventSchema.safeParse({ ...event, timestamp: 1800000000 }).success).toBe(false);
  });
  it("namespaces incoming and outgoing IDs by connected account", async () => {
    expect(whatsappMessageId("a", "same")).not.toBe(whatsappMessageId("b", "same"));
    vi.mocked(bridgeRequest).mockResolvedValueOnce({ events: [event] });
    await ingestWhatsAppEvents();
    expect(mocks.prisma.message.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { mid: "wa:account:incoming" }, create: expect.objectContaining({ createdAt: new Date(event.timestamp) }) }));
    await expect(withWhatsAppTurn(turn, () => sendWhatsAppText(contact, "Ответ"))).resolves.toBe("wa:account:outgoing");
  });
  it("never generates a blank generic response when media is unavailable", async () => {
    mocks.prisma.whatsAppInbox.findUnique.mockResolvedValueOnce({ ...turn, id: turn.inboxId, payload: JSON.stringify({ ...event, text: "", mediaUnavailable: "download_failed" }) });
    await expect(processInbox(turn.inboxId)).rejects.toThrow("Вложение WhatsApp недоступно");
    expect(mocks.aiReply).not.toHaveBeenCalled();
  });
  it("does not spend AI calls or claim queue work while bridge paused", async () => {
    vi.mocked(bridgeRequest).mockResolvedValueOnce({ accountId: "account", enabled: false, contactsReady: true });
    await dispatchWhatsAppInbox();
    expect(mocks.prisma.whatsAppInbox.findMany).not.toHaveBeenCalled(); expect(mocks.aiReply).not.toHaveBeenCalled();
  });
  it("does not process old account events after account switch", async () => {
    vi.mocked(bridgeRequest).mockResolvedValueOnce({ accountId: "other", enabled: true, contactsReady: true });
    await expect(processInbox(turn.inboxId)).rejects.toThrow("другой аккаунт"); expect(mocks.aiReply).not.toHaveBeenCalled();
  });
  it("persists takeover discovered on bridge even without human event", async () => {
    vi.mocked(bridgeRequest).mockImplementation(async path => path === "/status"
      ? { accountId: "account", enabled: true, contactsReady: true } as never : { ...safe, takenOver: true } as never);
    await processInbox(turn.inboxId);
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith(expect.objectContaining({ data: { humanTakenOverAt: expect.any(Date) } }));
    expect(mocks.aiReply).not.toHaveBeenCalled();
  });
  it("recognizes real generation retry prefix and ignores send failures", () => {
    expect(isWhatsAppGenerationRetry(new Error("WhatsAppGenerationRetry: no keys"))).toBe(true);
    expect(isWhatsAppGenerationRetry(new Error("Send outcome uncertain"))).toBe(false);
  });
  it("blocks background sending without incoming turn", async () => {
    await expect(sendWhatsAppText(contact, "Напоминание")).rejects.toThrow("только ответы");
  });
  it("uses distinct stable ordinals for multiple verified receipt deliveries", async () => {
    mocks.prisma.whatsAppInbox.findMany.mockResolvedValue([{ id: turn.inboxId, accountId: "account", chatId: "chat", replyToId: "incoming", payload: JSON.stringify({ imageHash: "hash" }) }]);
    await withVerifiedReceiptDelivery("contact", "hash", async () => {
      await sendWhatsAppText(contact, "Курс один", [], "verified_receipt_access");
      await sendWhatsAppText(contact, "Курс два", [], "verified_receipt_access");
    });
    const operations = vi.mocked(bridgeRequest).mock.calls.filter(call => call[0] === "/send").map(call => (call[1] as { operationId: string }).operationId);
    expect(operations).toHaveLength(2); expect(operations[0]).not.toBe(operations[1]);
  });
});
