import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ответы Ширин со своего телефона в WhatsApp — образцы манеры для бота
 * (ai/styleLearning.ts). До 08.11.2026 в образцы попадал только Instagram.
 */
const mocks = vi.hoisted(() => {
  const prisma = {
    contact: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    whatsAppInbox: { upsert: vi.fn() },
    message: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma, rememberOwnerReply: vi.fn(async () => undefined) };
});
vi.mock("../../src/db.js", () => ({ prisma: mocks.prisma, getSetting: vi.fn(), logError: vi.fn() }));
vi.mock("../../src/ai.js", () => ({ aiReply: vi.fn(), rescueImage: vi.fn() }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn() }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: mocks.rememberOwnerReply }));
vi.mock("../../src/whatsapp/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/whatsapp/client.js")>()),
  bridgeRequest: vi.fn(),
  whatsappConfigured: () => true,
}));
import { bridgeRequest } from "../../src/whatsapp/client.js";
import { ingestWhatsAppEvents } from "../../src/whatsapp/worker.js";

const human = { id: "h1", messageId: "h1", accountId: "acc", chatId: "chat", type: "human", timestamp: Date.now(), text: "Кабул кардем, хозир дохил мекнем" };
const client = { id: "contact", igUserId: "acc:chat", channel: "WHATSAPP", personal: false, whatsappSavedContact: false, spamBlockedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mocks.prisma));
  mocks.prisma.contact.upsert.mockResolvedValue(client);
  mocks.prisma.message.findUnique.mockResolvedValue({ byHuman: true });
  mocks.prisma.message.findFirst.mockResolvedValue({ text: "Пул гузарондам" });
  vi.mocked(bridgeRequest).mockImplementation(async (p: string) => (p === "/events" ? { events: [human] } : {}) as never);
});

describe("WhatsApp: ответ Ширин учит бота её манере", () => {
  it("ответ клиентке становится образцом «вопрос → ответ Ширин»", async () => {
    await ingestWhatsAppEvents();
    expect(mocks.rememberOwnerReply).toHaveBeenCalledWith("Пул гузарондам", human.text, "TAKEOVER", undefined, "contact");
  });
  it("личный контакт, сохранённый в телефоне или спам — не учимся", async () => {
    for (const extra of [{ personal: true }, { whatsappSavedContact: true }, { spamBlockedAt: new Date() }]) {
      mocks.prisma.contact.upsert.mockResolvedValueOnce({ ...client, ...extra });
      await ingestWhatsAppEvents();
    }
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
  });
  it("чат, где клиент ещё ничего не писал, и эхо ответа самого бота — не учимся", async () => {
    mocks.prisma.message.findFirst.mockResolvedValueOnce(null);
    await ingestWhatsAppEvents();
    mocks.prisma.message.findUnique.mockResolvedValueOnce({ byHuman: false });
    await ingestWhatsAppEvents();
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
  });
});
