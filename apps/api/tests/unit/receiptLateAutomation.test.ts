import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Два живых случая 08.11.2026.
 *  1) donish.go: чек на ЧУЖОЙ номер, бот просил чек, клиент ответил сердечками;
 *     следом ушёл шаблон «оплату не удалось подтвердить» - его отправило нажатие
 *     «Отклонить» владельцем, но повторять просьбу «пришлите чек» не нужно, а
 *     смайлики в шаблонах чека/доступа не нужны вовсе.
 *  2) 11._.66_: Ширин выдала ссылку сама, а отложенная перепроверка чека после
 *     этого спросила «Шумо Telegram доред?». Один платёж - одна выдача.
 */
const sendToContact = vi.fn(async (..._a: unknown[]) => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => null);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: vi.fn(async () => 1),
  editCaption: vi.fn(async () => undefined),
}));
const grantCourses = vi.fn(async (..._a: unknown[]) => ["COURSE70"]);
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: vi.fn(async () => null) }));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { awaitingDeliveryChoice, askDeliveryChoice } from "../../src/course/deliveryChoice.js";
import { decideReceipt } from "../../src/receiptDecision.js";
import { claimsReceiptSent } from "../../src/ai/receiptClaim.js";

let db: PrismaMock;
const contact = fakeContact({ askedAltScreenshotAt: null, paid: false }) as Parameters<typeof handleReceiptVerdict>[0];

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    kind: "valid" as const,
    confidence: 95,
    amount: 71.45,
    currency: "TJS",
    receiptAt: null as Date | null,
    recipientMatches: true,
    tamperingSuspected: false,
    reason: "Завершённый перевод, Душанбе Сити",
    imageHash: "hash-late",
    imageUrl: "/media/r.jpg",
    ...overrides,
  };
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockResolvedValue(null);
  db.model("blockedReceipt").findUnique.mockResolvedValue(null);
  db.model("receiptCheck").findFirst.mockResolvedValue(null);
  db.model("receiptCheck").update.mockResolvedValue({ id: "q1" });
  db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
  db.model("purchase").findMany.mockResolvedValue([]);
  db.model("purchase").count.mockResolvedValue(0);
  db.model("message").findFirst.mockResolvedValue({ text: "Рахмат" });
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  grantCourses.mockClear();
});
afterEach(() => {
  restorePrisma();
});

describe("случай 2: отложенная автоматика после ручной выдачи", () => {
  const queuedRow = async ({ where }: { where: Record<string, unknown> }) =>
    where.id ? { createdAt: new Date(Date.now() - 4 * 60_000) } : null;

  it("перепроверка из очереди, Ширин уже выдала ссылку: ни выдачи, ни вопросов, ни тревоги", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    // покупка именно на курс за 70 получила ссылку после чека
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70" }]);
    await handleReceiptVerdict(contact, verdict(), "q1");
    expect(db.model("purchase").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: [{ inviteLink: { not: null } }, { accessIssuedAt: { not: null } }], revokedAt: null }) }),
    );
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "HANDLED", linkSent: true }) }),
    );
  });

  it("выдан ДРУГОЙ курс: оплата за 70 не теряется, автоматика работает", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE50" }]); // ссылка есть только на курс за 50
    db.model("message").findMany.mockResolvedValue([]);
    await handleReceiptVerdict(contact, verdict({ receiptAt: new Date() }), "q1");
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("Ширин прислала настоящую ссылку, но покупок нет: не молчим, а отдаём чек владельцу без сообщений клиентке", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("setting").findUnique.mockResolvedValue({ key: "telegramBotToken", value: "t" });
    db.model("message").findMany.mockResolvedValue([
      { text: "Вот ссылка https://shirinsweets.online/l/aBcD234567" },
    ]);
    await handleReceiptVerdict(contact, verdict(), "q1");
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("вторая оплата того же размера не закрывается молча: другой чек уже открыл доступ", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("receiptCheck").count.mockResolvedValue(1); // чек A уже выдал курс
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70" }]);
    await handleReceiptVerdict(contact, verdict(), "q1");
    expect(db.model("receiptCheck").update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "HANDLED" }) }),
    );
  });

  it("сумма в рублях, Ширин прислала ссылку: клиентке не пишем, чек владельцу", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("setting").findUnique.mockResolvedValue({ key: "telegramBotToken", value: "t" });
    db.model("message").findMany.mockResolvedValue([{ text: "https://shirinsweets.online/l/aBcD234567" }]);
    await handleReceiptVerdict(contact, verdict({ amount: 650, currency: "RUB" }), "q1");
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("комплект: одна ссылка Ширин не снимает ожидание у обеих оплаченных покупок", async () => {
    db.model("purchase").count.mockResolvedValue(2);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", createdAt: new Date(Date.now() - 600_000), inviteLink: null },
      { id: "p2", createdAt: new Date(Date.now() - 600_000), inviteLink: null },
    ]);
    db.model("message").findMany.mockResolvedValue([{ text: "https://t.me/+abcDEF123" }]);
    expect(await awaitingDeliveryChoice(contact.id)).toBe(true);
    expect(db.model("purchase").updateMany).not.toHaveBeenCalled();
  });

  it("ссылка на рилс, сайт или ник не считается выдачей", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("message").findMany.mockResolvedValue([
      { text: "Посмотрите https://www.instagram.com/reel/abc и https://shirinsweets.online/ @shirinsweets" },
    ]);
    await handleReceiptVerdict(contact, verdict(), "q1");
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("перепроверка, когда доступ НЕ выдавали: работает как обычно", async () => {
    db.model("receiptCheck").findUnique.mockImplementation(queuedRow);
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("message").findMany.mockResolvedValue([{ text: "Ширин, добрый день" }]); // ответ без ссылки
    await handleReceiptVerdict(contact, verdict(), "q1");
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("вопрос «есть ли Telegram?» снимается у покупки, которой уже выдана ссылка", async () => {
    db.model("purchase").count.mockResolvedValue(1);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", createdAt: new Date(Date.now() - 600_000), inviteLink: "https://x/l/abc" },
    ]);
    expect(await awaitingDeliveryChoice(contact.id)).toBe(false);
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p1"] } }, data: expect.objectContaining({ deliveryAwaitingChoice: false }) }),
    );
    await askDeliveryChoice(contact);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("вопрос о доставке остаётся, пока ссылка не выдана; обычное сообщение Ширин его не снимает", async () => {
    db.model("purchase").count.mockResolvedValue(1);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", createdAt: new Date(Date.now() - 600_000), inviteLink: null },
    ]);
    db.model("message").findMany.mockResolvedValue([{ text: "Рахмат, ждите" }]);
    expect(await awaitingDeliveryChoice(contact.id)).toBe(true);
    expect(db.model("purchase").updateMany).not.toHaveBeenCalled();
  });

  it("снимается только покупка с выданной ссылкой, вторая ждущая остаётся", async () => {
    db.model("purchase").count.mockResolvedValue(2);
    db.model("purchase").findMany.mockResolvedValue([
      { id: "p1", createdAt: new Date(Date.now() - 600_000), inviteLink: "https://x/l/abc" },
      { id: "p2", createdAt: new Date(Date.now() - 500_000), inviteLink: null },
    ]);
    db.model("message").findMany.mockResolvedValue([]);
    expect(await awaitingDeliveryChoice(contact.id)).toBe(true);
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["p1"] } } }),
    );
  });
});

describe("случай 1: не повторять «пришлите чек»", () => {
  function pending(extra: Record<string, unknown> = {}) {
    return {
      id: "r1",
      imageHash: "h",
      contactId: contact.id,
      contact,
      amount: 300,
      reason: "чужой номер",
      ownerDecision: "PENDING",
      ...extra,
    };
  }

  it("«Отклонить» после того, как бот уже просил чек: второе сообщение не уходит", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(pending());
    db.model("message").findFirst.mockResolvedValue({ text: "🫶♥️" });
    db.model("message").findMany.mockResolvedValue([
      { text: "Чек чандон возеҳ дида намешавад. Лутфан сурати дигар фиристед — метавонед аз таърихи бонк гиред." },
    ]);
    const result = await decideReceipt("r1", "reject");
    expect(result).toMatchObject({ ok: true, status: "rejected" });
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("обычные реквизиты («скриншоти чекро ҳамин ҷо фиристед») не считаются просьбой: отказ после оплаты клиентке уходит", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(pending());
    db.model("message").findFirst.mockResolvedValue({ text: "Вот чек" });
    db.model("message").findMany.mockResolvedValue([
      { text: "Баъди пардохт скриншоти чекро ҳамин ҷо фиристед." },
      { text: "Оплатите и пришлите скриншот чека сюда" },
    ]);
    await decideReceipt("r1", "reject");
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });

  it("«Отклонить», когда клиентку ещё не просили: шаблон уходит один раз", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(pending());
    db.model("message").findFirst.mockResolvedValue({ text: "Вот чек" });
    db.model("message").findMany.mockResolvedValue([]);
    await decideReceipt("r1", "reject");
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });

  it("эмодзи, стикеры и благодарности не считаются сообщением об оплате", () => {
    for (const t of ["🫶♥️", "❤️", "🥰", "Рахмат", "рахмат", "хоб", "Спасибо", "ok", "👍"]) {
      expect(claimsReceiptSent(t), t).toBe(false);
    }
  });
});

describe("в шаблонах чека, доступа и восстановления нет смайликов", () => {
  const files = [
    "src/ai/receiptVerdict.ts",
    "src/receiptDecision.ts",
    "src/receiptRetry.ts",
    "src/ai/receiptCheck.ts",
    "src/course/recovery.ts",
    "src/course/deliveryChoice.ts",
    "src/joinReminder.ts",
  ];
  const emoji = /\p{Extended_Pictographic}/u;
  it.each(files)("%s", (file) => {
    const lines = fs
      .readFileSync(path.join(__dirname, "../..", file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(lines.filter((l) => emoji.test(l))).toEqual([]);
  });
});
