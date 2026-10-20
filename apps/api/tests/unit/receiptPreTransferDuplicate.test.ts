import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Две ошибки из переписки 04.09.2026 (@usuf.jon2021):
 *  1) экран проверки получателя («ввела номер, банк показал Фарангис») шёл как
 *     нечёткий чек с просьбой прислать ещё — теперь бот отвечает «да, верно»;
 *  2) тот же чек на 70 сомони, присланный второй раз, открыл ВТОРОЙ курс как
 *     новую покупку — теперь это «уже приняли», без выдачи.
 */
const sendToContact = vi.fn(async () => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async () => undefined);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: vi.fn(async () => 1),
}));
const grantCourses = vi.fn(async () => ["COURSE50"]);
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: vi.fn(async () => null) }));
vi.mock("../../src/courses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/courses.js")>()),
  allocate: vi.fn(async () => ({ grant: ["COURSE50"], note: "второй курс: Арт-десерты", discounted: false })),
}));

import { confirmRequisitesToCustomer, handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { pickReceiptVerdict, type ReceiptVerdict } from "../../src/ai/receiptCheck.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { telegramBotToken: "t", telegramOwnerChatId: "1" };
const contact = fakeContact({ askedAltScreenshotAt: null, paid: true }) as Parameters<typeof handleReceiptVerdict>[0];

function valid70(hash = "hash-2") {
  return { kind: "valid" as const, confidence: 98, amount: 70, receiptAt: null, reason: "чек на 70", imageHash: hash, imageUrl: "/media/r.jpg" };
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
  db.model("message").findFirst.mockResolvedValue({ text: "Вот чек" });
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  grantCourses.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("экран до перевода", () => {
  it("отвечает «да, всё верно» с реквизитами на языке клиентки, ничего не эскалирует", async () => {
    db.model("message").findFirst.mockResolvedValue({ text: "Ҳамин рақам дуруст аст, апачон? Чекро мефиристам" });
    await confirmRequisitesToCustomer(contact, null);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    const text = String(sendToContact.mock.calls[0][1]);
    expect(text).toContain("Ҳа, ҳамааш дуруст");
    expect(text).toContain("905 355 355 Чаборова Фарангис (Душанбе Сити, Алиф)");
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });

  it("явный текст сообщения перевешивает историю при выборе языка", async () => {
    await confirmRequisitesToCustomer(contact, "правильно ввела?");
    expect(String(sendToContact.mock.calls[0][1])).toContain("Да, всё верно");
    expect(db.model("message").findFirst).not.toHaveBeenCalled();
  });
});

describe("несколько фото в одном сообщении", () => {
  const v = (kind: ReceiptVerdict["kind"]) => ({ verdict: { kind } as ReceiptVerdict, tag: kind });
  it("настоящий чек важнее экрана до перевода и «не чека»", () => {
    expect(pickReceiptVerdict([v("pre_transfer"), v("valid"), null, v("not_receipt")])?.tag).toBe("valid");
    expect(pickReceiptVerdict([v("not_receipt"), v("pre_transfer")])?.tag).toBe("pre_transfer");
    expect(pickReceiptVerdict([v("suspicious"), v("pre_transfer")])?.tag).toBe("suspicious");
    expect(pickReceiptVerdict([null, null])).toBeNull();
  });
});

describe("тот же перевод второй раз", () => {
  it("та же сумма уже открыла доступ за 48 ч — курс не выдаём, клиентке «уже приняли», владельцу на глаза", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.linkSent === true && where.amount === 70 ? { createdAt: new Date() } : null
    );
    await handleReceiptVerdict(contact, valid70());
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toContain("уже приняли");
    const created = db.model("receiptCheck").create.mock.calls[0][0] as { data: { kind: string; reason: string } };
    expect(created.data.kind).toBe("suspicious");
    expect(created.data.reason).toMatch(/тот же перевод прислан второй раз/);
  });

  it("без прежнего чека на ту же сумму — обычная выдача", async () => {
    await handleReceiptVerdict(contact, valid70());
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });
});
