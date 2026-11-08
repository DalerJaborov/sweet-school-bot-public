import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * ТЕСТЫ НА НАСТОЯЩЕЙ SQLITE (ревью PR 67): моки с готовыми ответами не ловят
 * ошибок в условиях запросов. Здесь схема накатывается во временный файл, а
 * Telegram и отправка клиенту - заглушки.
 */
const sendToContact = vi.fn(async (..._a: unknown[]) => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => ({ chatId: "owner-1", messageId: 5 }));
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  editCaption: vi.fn(async () => undefined),
}));
const grantCourses = vi.fn(async (..._a: unknown[]) => ["COURSE70"]);
vi.mock("../../src/ai.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: vi.fn(async () => null) }));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { settleChoiceIfHandedOut } from "../../src/course/handedOut.js";
import { closeSettledReceiptAlerts, resetSweepClock } from "../../src/receiptAlerts.js";
import { decideReceipt } from "../../src/receiptDecision.js";
import { resetPriceCache } from "../../src/services/priceService.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-real-"));
const dbFile = path.join(dir, "test.db").replace(/\\/g, "/");
let db: PrismaClient;

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "ignore",
  });
  db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
  setPrismaClient(db);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
  setPrismaClient(originalPrisma);
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetPriceCache();
  resetSweepClock();
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  sendTelegramMessage.mockClear();
  grantCourses.mockClear();
  for (const t of ["receiptCheck", "purchase", "message", "contact", "setting"] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.create({ data: { key: "telegramBotToken", value: "tok" } });
});

async function newContact(id: string) {
  return db.contact.create({ data: { id, igUserId: `ig-${id}`, username: id } });
}

function verdict(hash: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "valid" as const,
    confidence: 95,
    amount: 70,
    currency: "TJS",
    receiptAt: new Date(),
    recipientMatches: true,
    tamperingSuspected: false,
    reason: "Перевод на наш номер",
    imageHash: hash,
    imageUrl: "/media/r.jpg",
    ...overrides,
  };
}

describe("настоящая база: ручная ссылка после вопроса о доставке", () => {
  it("платёж 70 ждёт ответа про Telegram, Ширин прислала t.me/+: чек получает linkSent, повтор скриншота его не затирает", async () => {
    const c = await newContact("c1");
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true },
    });
    await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "valid",
        confidence: 95,
        reason: "ok",
        imageHash: "h1",
        amount: 70,
        awaitingDeliveryChoice: true,
      },
    });
    await db.message.create({
      data: { contactId: c.id, direction: "OUT", byHuman: true, text: "Вот группа https://t.me/+abcDEF123xyz" },
    });

    expect(await settleChoiceIfHandedOut(c.id)).toBe(true);
    const row = await db.receiptCheck.findUnique({ where: { imageHash: "h1" } });
    expect(row).toMatchObject({ linkSent: true, awaitingDeliveryChoice: false, kind: "valid" });

    // через час клиентка шлёт тот же скриншот
    await handleReceiptVerdict(c, verdict("h1", { amount: 70 }));
    const after = await db.receiptCheck.findUnique({ where: { imageHash: "h1" } });
    expect(after).toMatchObject({ kind: "valid", linkSent: true, ownerDecision: null });
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendToContact).toHaveBeenCalledTimes(1); // "уже приняли" (язык по последнему сообщению)
  });

  it("два скриншота у клиентки без выбора доставки (71, потом 71 без даты): второй не уходит владельцу", async () => {
    const c = await newContact("c2");
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true },
    });
    await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "valid",
        confidence: 95,
        reason: "ok",
        imageHash: "first",
        amount: 71,
        awaitingDeliveryChoice: true,
      },
    });
    await handleReceiptVerdict(c, verdict("second", { amount: 71, receiptAt: null }));
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(grantCourses).not.toHaveBeenCalled();
    const second = await db.receiptCheck.findUnique({ where: { imageHash: "second" } });
    expect(second?.kind).toBe("duplicate");
  });

  it("другой номер операции у второго скриншота: это новый перевод, не молчаливый повтор", async () => {
    const c = await newContact("c3");
    await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "valid",
        confidence: 95,
        reason: "ok",
        imageHash: "a",
        amount: 50,
        linkSent: true,
        transactionId: "TXN-AAAAAA1",
      },
    });
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE50", amount: 50, inviteLink: "https://x/l/abc" },
    });
    await handleReceiptVerdict(c, verdict("b", { amount: 50, transactionId: "TXN-BBBBBB2" }));
    const b = await db.receiptCheck.findUnique({ where: { imageHash: "b" } });
    expect(b?.kind).not.toBe("duplicate");
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect((sendReceiptForReview.mock.calls[0][2] as { caption: string }).caption).toMatch(/Подтвердить откроет/);
  });
});

describe("настоящая база: уборка тревог", () => {
  it("два ждущих чека на 70 и одна выдача курса за 70: закрывается один, а не оба", async () => {
    const c = await newContact("c4");
    const old = new Date(Date.now() - 30 * 60_000);
    for (const h of ["w1", "w2"]) {
      await db.receiptCheck.create({
        data: {
          contactId: c.id,
          kind: "suspicious",
          confidence: 90,
          reason: "r",
          imageHash: h,
          amount: 70,
          ownerDecision: "PENDING",
          createdAt: old,
        },
      });
    }
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/abc" },
    });
    await closeSettledReceiptAlerts();
    resetSweepClock();
    await closeSettledReceiptAlerts();
    const rows = await db.receiptCheck.findMany({ where: { contactId: c.id } });
    expect(rows.filter((r) => r.ownerDecision === "HANDLED")).toHaveLength(1);
    expect(rows.filter((r) => r.ownerDecision === "PENDING")).toHaveLength(1);
  });

  it("чек за 50 ждёт, выдан только курс за 70: чек за 50 остаётся", async () => {
    const c = await newContact("c5");
    await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "suspicious",
        confidence: 90,
        reason: "r",
        imageHash: "x50",
        amount: 50,
        ownerDecision: "PENDING",
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/abc" },
    });
    await closeSettledReceiptAlerts();
    const row = await db.receiptCheck.findUnique({ where: { imageHash: "x50" } });
    expect(row?.ownerDecision).toBe("PENDING");
  });
});

describe("настоящая база: поток «нечёткий чек, потом чёткий» и кнопка «Подтвердить»", () => {
  it("курс за 70 уже выдан по чёткому чеку: «Подтвердить» по нечёткому чеку на 70 НЕ выдаёт курс за 50", async () => {
    const c = await newContact("c6");
    // нечёткий чек на 70 ждёт владельца
    const blurry = await db.receiptCheck.create({
      data: { contactId: c.id, kind: "suspicious", confidence: 30, reason: "размыто", imageHash: "blurry", amount: 70, ownerDecision: "PENDING", createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    // чёткий чек на 70 прошёл сам: курс за 70 выдан
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/abc" } });
    await db.receiptCheck.create({
      data: { contactId: c.id, kind: "valid", confidence: 95, reason: "ok", imageHash: "clear", amount: 70, linkSent: true },
    });

    const result = await decideReceipt(blurry.id, "approve");
    expect(result).toMatchObject({ ok: true, status: "approved_no_link" });
    expect(String((result as { message: string }).message)).toMatch(/дубль|уже есть/);
    expect(grantCourses).not.toHaveBeenCalled();
    const purchases = await db.purchase.findMany({ where: { contactId: c.id } });
    expect(purchases.map((p) => p.course)).toEqual(["COURSE70"]);
  });

  it("обычное подтверждение: курс по сумме выдаётся", async () => {
    const c = await newContact("c7");
    const r = await db.receiptCheck.create({
      data: { contactId: c.id, kind: "suspicious", confidence: 90, reason: "r", imageHash: "plain", amount: 71, ownerDecision: "PENDING" },
    });
    grantCourses.mockResolvedValueOnce(["COURSE70"]);
    const result = await decideReceipt(r.id, "approve");
    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect((grantCourses.mock.calls[0][1] as { grant: string[] }).grant).toEqual(["COURSE70"]);
  });

  it("автоматика: старый чек на 70 у владелицы курса за 70 уходит на проверку с кнопкой «Закрыть как дубль»", async () => {
    const c = await newContact("c8");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/abc" } });
    await handleReceiptVerdict(c, verdict("old70", { receiptAt: new Date() }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect((sendReceiptForReview.mock.calls[0][2] as { closeAsDuplicate: boolean }).closeAsDuplicate).toBe(true);
  });

  it("две честные оплаты (50 и 70) выданы вручную: уборка закрывает оба ждущих чека", async () => {
    const c = await newContact("c9");
    const old = new Date(Date.now() - 30 * 60_000);
    for (const [h, a] of [["m50", 50], ["m70", 70]] as const) {
      await db.receiptCheck.create({ data: { contactId: c.id, kind: "suspicious", confidence: 90, reason: "r", imageHash: h, amount: a, ownerDecision: "PENDING", createdAt: old } });
    }
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE50", amount: 50, inviteLink: "https://x/l/a" } });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/b" } });
    await closeSettledReceiptAlerts();
    resetSweepClock();
    await closeSettledReceiptAlerts();
    const rows = await db.receiptCheck.findMany({ where: { contactId: c.id } });
    expect(rows.every((r) => r.ownerDecision === "HANDLED")).toBe(true);
  });
});
