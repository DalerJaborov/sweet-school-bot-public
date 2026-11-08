import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { ingestWhatsAppEvents, OWNER_LEARN_DELAY_MS } from "../../src/whatsapp/worker.js";

/** Приём событий + пауза, после которой проверяется, что это правда Ширин. */
async function ingestAndWait(): Promise<void> {
  await ingestWhatsAppEvents();
  await vi.advanceTimersByTimeAsync(OWNER_LEARN_DELAY_MS);
}

const human = { id: "h1", messageId: "h1", accountId: "acc", chatId: "chat", type: "human", timestamp: Date.now(), text: "Кабул кардем, хозир дохил мекнем" };
const client = { id: "contact", igUserId: "acc:chat", channel: "WHATSAPP", personal: false, whatsappSavedContact: false, spamBlockedAt: null };

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mocks.prisma));
  mocks.prisma.contact.upsert.mockResolvedValue(client);
  mocks.prisma.message.findUnique.mockResolvedValue({ byHuman: true });
  mocks.prisma.message.findFirst.mockResolvedValue({ text: "Пул гузарондам" });
  vi.mocked(bridgeRequest).mockImplementation(async (p: string) => (p === "/events" ? { events: [human] } : {}) as never);
});

describe("WhatsApp: ответ Ширин учит бота её манере", () => {
  it("до паузы не учимся: мост мог прислать событие раньше, чем бот записал свой mid", async () => {
    await ingestWhatsAppEvents();
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
    // Бот успел записать своё сообщение — пометка «человек» снята, образца нет.
    mocks.prisma.message.findUnique.mockResolvedValueOnce({ byHuman: false });
    await vi.advanceTimersByTimeAsync(OWNER_LEARN_DELAY_MS);
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
  });
  it("вопрос клиента ищется только за последние сутки до ответа Ширин и без нажатий кнопок", async () => {
    await ingestAndWait();
    const where = mocks.prisma.message.findFirst.mock.calls[0][0].where;
    expect(where.payload).toBeNull();
    expect(where.createdAt.lte.getTime() - where.createdAt.gte.getTime()).toBe(24 * 3_600_000);
    expect(where.createdAt.lte.getTime()).toBe(human.timestamp);
  });
  it("ответ клиентке становится образцом «вопрос → ответ Ширин»", async () => {
    await ingestAndWait();
    expect(mocks.rememberOwnerReply).toHaveBeenCalledWith("Пул гузарондам", human.text, "TAKEOVER", undefined, "contact");
  });
  it("личный контакт, сохранённый в телефоне или спам — не учимся", async () => {
    for (const extra of [{ personal: true }, { whatsappSavedContact: true }, { spamBlockedAt: new Date() }]) {
      mocks.prisma.contact.upsert.mockResolvedValueOnce({ ...client, ...extra });
      await ingestAndWait();
    }
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
  });
  it("чат, где клиент ещё ничего не писал, и эхо ответа самого бота — не учимся", async () => {
    mocks.prisma.message.findFirst.mockResolvedValueOnce(null);
    await ingestAndWait();
    mocks.prisma.message.findUnique.mockResolvedValueOnce({ byHuman: false });
    await ingestAndWait();
    expect(mocks.rememberOwnerReply).not.toHaveBeenCalled();
  });
});
