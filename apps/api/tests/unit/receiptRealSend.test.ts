import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * НАСТОЯЩАЯ ОТПРАВКА (ревью PR 72): messaging/send.ts не заглушен, настоящая
 * SQLite. Заглушены только транспорт Instagram, Telegram и выдача курсов.
 * Раньше тесты глушили всю отправку и не видели, что напоминание с пометкой
 * "чек проверен" вне проверки чека молча блокируется.
 */
const sendText = vi.fn(async (..._a: unknown[]) => `ig-mid-${Math.random().toString(36).slice(2, 8)}`);
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendAttachment: vi.fn(async () => "att-1"),
  channelOf: (c: { channel?: string }) => c.channel ?? "INSTAGRAM",
}));
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => ({ chatId: "owner-1", messageId: 5 }));
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: vi.fn(async () => 1),
  editCaption: vi.fn(async () => undefined),
}));
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: vi.fn(async () => ["COURSE50"]) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: vi.fn(async () => null) }));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-send-"));
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
  sendText.mockClear();
  sendReceiptForReview.mockClear();
  for (const t of ["receiptCheck", "purchase", "message", "contact", "setting"] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.create({ data: { key: "telegramBotToken", value: "tok" } });
  await db.setting.create({ data: { key: "courseDeliveryMode", value: "both" } });
});

function verdict(hash: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "valid" as const,
    confidence: 95,
    amount: 50,
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

async function waitingContact(id: string) {
  const c = await db.contact.create({
    data: {
      id,
      igUserId: `ig-${id}`,
      username: id,
      deliveryChoicePromptState: "WAITING",
      deliveryChoicePromptMid: "q-old",
    },
  });
  await db.purchase.create({ data: { contactId: id, course: "COURSE50", amount: 50, deliveryAwaitingChoice: true } });
  await db.receiptCheck.create({
    data: {
      contactId: id,
      kind: "valid",
      confidence: 95,
      reason: "ok",
      imageHash: `${id}-first`,
      amount: 50,
      awaitingDeliveryChoice: true,
    },
  });
  return c;
}

describe("настоящая отправка: напоминание про Telegram доходит до клиентки", () => {
  it("тот же скриншот повторно, пока ждём ответа: клиентке уходит напоминание", async () => {
    const c = await waitingContact("s1");
    await handleReceiptVerdict(c, verdict("s1-first"));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toMatch(/Telegram/);
    const fresh = await db.contact.findUnique({ where: { id: c.id } });
    expect(fresh?.deliveryChoicePromptMid).not.toBe("q-old");
  });

  it("другой скриншот того же перевода, пока ждём ответа: клиентке уходит напоминание, владельцу не шумим", async () => {
    const c = await waitingContact("s2");
    await handleReceiptVerdict(c, verdict("s2-second"));
    expect(sendText.mock.calls.map((x) => String(x[1])).join(" ")).toMatch(/Telegram/);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });

  it("если Ширин перехватила чат, напоминание по принятому чеку всё равно доходит (область принятого чека)", async () => {
    const c = await waitingContact("s3");
    await db.contact.update({ where: { id: c.id }, data: { humanTakenOverAt: new Date() } });
    const fresh = await db.contact.findUnique({ where: { id: c.id } });
    await handleReceiptVerdict(fresh as typeof c, verdict("s3-first"));
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("тот же номер операции, пока ждём ответа, Ширин перехватила чат: напоминание доходит (отпечаток принятого чека передан)", async () => {
    const c = await waitingContact("s4");
    await db.receiptCheck.updateMany({ where: { contactId: c.id }, data: { transactionId: "TXN-S4-111111" } });
    await db.contact.update({ where: { id: c.id }, data: { humanTakenOverAt: new Date() } });
    const fresh = await db.contact.findUnique({ where: { id: c.id } });
    await handleReceiptVerdict(fresh as typeof c, verdict("s4-second", { transactionId: "TXN-S4-111111" }));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toMatch(/Telegram/);
  });
});
