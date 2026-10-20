import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Чек ушёл владельцу — клиентке уходит «чек получила, передаю Ширин», ровно
 * один раз на чек (05.09.2026: раньше после эскалации была тишина до утра).
 */
const sendToContact = vi.fn(async () => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async () => undefined);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: vi.fn(async () => 1),
}));
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: vi.fn(async () => []) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: vi.fn(async () => null) }));
vi.mock("../../src/courses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/courses.js")>()),
  allocate: vi.fn(async () => ({ grant: ["COURSE70"], note: "70 сомони", discounted: false })),
}));

import { handleReceiptVerdict, notifyCustomerReceiptForwarded } from "../../src/ai/receiptVerdict.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { telegramBotToken: "t", telegramOwnerChatId: "1" };

/** Контакт, у которого «пришлите другой скриншот» уже спрашивали — чек идёт владельцу сразу. */
const contact = fakeContact({ askedAltScreenshotAt: new Date() }) as Parameters<typeof handleReceiptVerdict>[0];

function suspicious() {
  return {
    kind: "suspicious" as const,
    confidence: 40,
    amount: 70,
    receiptAt: null,
    reason: "размыто",
    imageHash: "hash-1",
    imageUrl: "/media/r.jpg",
  };
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("blockedReceipt").findUnique.mockResolvedValue(null);
  db.model("receiptCheck").findFirst.mockResolvedValue(null);
  db.model("receiptCheck").create.mockResolvedValue({ id: "r1" });
  db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
  db.model("message").findFirst.mockResolvedValue({ text: "Вот чек, проверьте" });
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Чек ушёл владельцу — клиентка не в тишине", () => {
  it("ГЛАВНОЕ: сомнительный чек — карточка владельцу и «передаю Ширин» клиентке на её языке", async () => {
    await handleReceiptVerdict(contact, suspicious());

    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toContain("Чек получила, передаю Ширин");
    expect(db.model("receiptCheck").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", customerNotifiedAt: null } })
    );
    expect(db.model("message").create).toHaveBeenCalledTimes(1);
  });

  it("по-таджикски — по-таджикски", async () => {
    db.model("message").findFirst.mockResolvedValue({ text: "Чекро фиристодам апачон" });
    await handleReceiptVerdict(contact, suspicious());
    expect(String(sendToContact.mock.calls[0][1])).toContain("Чекро гирифтам");
  });

  it("второй разбор того же чека — сообщение не повторяется (отметка уже стоит)", async () => {
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    await handleReceiptVerdict(contact, suspicious());
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("известное мошенничество (чёрный список) — владельцу да, клиентке ничего", async () => {
    db.model("blockedReceipt").findUnique.mockResolvedValue({ imageHash: "hash-1", reason: "подделка" });
    await handleReceiptVerdict(contact, suspicious());
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("сначала просим другой скриншот — «передаю Ширин» не уходит: чек ещё не у неё", async () => {
    const fresh = fakeContact({ askedAltScreenshotAt: null }) as Parameters<typeof handleReceiptVerdict>[0];
    await handleReceiptVerdict(fresh, suspicious());
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toContain("не совсем понятно читается");
  });

  it("notifyCustomerReceiptForwarded из очереди перепроверки — та же атомарная отметка", async () => {
    await notifyCustomerReceiptForwarded(contact, { id: "r9" });
    await notifyCustomerReceiptForwarded(contact, { id: "r9" });
    expect(db.model("receiptCheck").updateMany).toHaveBeenCalledTimes(2);
    // Обе попытки прошли (мок отдаёт count=1) — в бою вторая получит count=0.
    expect(sendToContact).toHaveBeenCalledTimes(2);
  });
});
