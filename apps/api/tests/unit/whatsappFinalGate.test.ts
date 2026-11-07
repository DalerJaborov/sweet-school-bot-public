import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma } from "../helpers.js";
const bridgeRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/whatsapp/client.js", () => ({ bridgeRequest, whatsappMessageId: (a: string, m: string) => `wa:${a}:${m}` }));
import { sendWhatsAppText, sendWhatsAppAttachment } from "../../src/whatsapp/transport.js";
import { withWhatsAppTurn } from "../../src/whatsapp/context.js";
import { withContactMessaging } from "../../src/messaging/automation.js";
const recipient = { id: "contact-1", channel: "WHATSAPP", igUserId: "account:chat" };
let frozen: boolean;
let takeover: boolean;
beforeEach(() => {
  frozen = false; takeover = false;
  const db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async () => ({ value: String(frozen) }));
  db.model("contact").findUnique.mockImplementation(async () => fakeContact({ humanTakenOverAt: takeover ? new Date() : null }));
  bridgeRequest.mockReset().mockImplementation(async (path: string) => {
    if (path === "/status") return { accountId: "account" };
    return { isMyContact: false, blocked: false, identityResolved: true, takenOver: false };
  });
});
afterEach(restorePrisma);
describe("WhatsApp final network gate", () => {
  it.each(["text", "attachment"])("stops %s when freeze changes during bridge authorization", async kind => {
    const original = bridgeRequest.getMockImplementation()!;
    bridgeRequest.mockImplementation(async (path: string) => {
      const result = await original(path);
      if (path.startsWith("/contact-status")) frozen = true;
      return result;
    });
    await expect(withWhatsAppTurn({ inboxId: "inbox", contactId: recipient.id, accountId: "account", chatId: "chat", messageId: "incoming" }, () =>
      withContactMessaging(recipient.id, "reply", () => kind === "text" ? sendWhatsAppText(recipient, "hello") : sendWhatsAppAttachment(recipient, "https://example.com/a.jpg", "image")))).rejects.toThrow("frozen");
    expect(bridgeRequest.mock.calls.some(([p]) => p === "/send")).toBe(false);
  });
  it("stops a pending answer when local takeover changes during authorization", async () => {
    const original = bridgeRequest.getMockImplementation()!;
    bridgeRequest.mockImplementation(async (path: string) => { const result = await original(path); if (path.startsWith("/contact-status")) takeover = true; return result; });
    await expect(withWhatsAppTurn({ inboxId: "inbox", contactId: recipient.id, accountId: "account", chatId: "chat", messageId: "incoming" }, () =>
      withContactMessaging(recipient.id, "reply", () => sendWhatsAppText(recipient, "hello")))).rejects.toThrow("contact policy");
    expect(bridgeRequest.mock.calls.some(([p]) => p === "/send")).toBe(false);
  });
});
