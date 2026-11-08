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
let midCounter = 0;
const sendToContact = vi.fn(async (..._a: unknown[]) => `mid-${++midCounter}`);
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
import { deferGrantForChoice, lastBotMessageIsQuestionOrService } from "../../src/course/deliveryChoice.js";
import { planForAmount, splitAmount } from "../../src/courses.js";
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
  await db.setting.create({ data: { key: "courseDeliveryMode", value: "both" } });
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

describe("настоящая база: ревью 4", () => {
  it("50 -> 70 у клиентки без выбора доставки: выдача по чеку 70 включает курс 70 (повтор доставки не подменяет)", async () => {
    const c = await newContact("d1");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE50", amount: 50, deliveryAwaitingChoice: true, source: "RECEIPT" } });
    const r = await db.receiptCheck.create({
      data: { contactId: c.id, kind: "suspicious", confidence: 90, reason: "r", imageHash: "b70", amount: 70, ownerDecision: "PENDING" },
    });
    grantCourses.mockResolvedValueOnce(["COURSE70"]);
    await decideReceipt(r.id, "approve");
    expect((grantCourses.mock.calls[0][1] as { grant: string[] }).grant).toEqual(["COURSE70"]);
  });

  it("есть курс 70, чек 100 с подозрением: карточка обещает курс за 50 и кнопка не 'дубль'", async () => {
    const c = await newContact("d2");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, inviteLink: "https://x/l/abc" } });
    await handleReceiptVerdict(c, verdict("b100", { amount: 100, tamperingSuspected: true }));
    const args = sendReceiptForReview.mock.calls[0][2] as { caption: string; closeAsDuplicate: boolean };
    expect(args.caption).toMatch(/Подтвердить откроет: Арт-десерты/);
    expect(args.closeAsDuplicate).toBe(false);
  });

  it("недоплата 40 у новой клиентки: не 'дубль', причина - сумма не сходится", async () => {
    const c = await newContact("d3");
    await handleReceiptVerdict(c, verdict("u40", { amount: 40 }));
    const args = sendReceiptForReview.mock.calls[0][2] as { caption: string; closeAsDuplicate: boolean };
    expect(args.closeAsDuplicate).toBe(false);
    expect(args.caption).toMatch(/сумма не сходится/);
  });

  it("второй платёж, пока ждём ответа про Telegram: клиентке уходит напоминание, а не тишина", async () => {
    const c = await db.contact.create({
      data: { id: "d4", igUserId: "ig-d4", username: "d4", deliveryChoicePromptState: "WAITING" },
    });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true } });
    await db.receiptCheck.create({
      data: {
        contactId: c.id, kind: "valid", confidence: 95, reason: "ok", imageHash: "first70", amount: 70,
        awaitingDeliveryChoice: true, createdAt: new Date(Date.now() - 40 * 60_000),
      },
    });
    await handleReceiptVerdict(c, verdict("second70", { amount: 70 }));
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/Telegram/);
  });

  it("округление: 43.6 автоматика и панель считают одинаково (оба - курс 50)", async () => {
    const c = await newContact("d5");
    grantCourses.mockResolvedValueOnce(["COURSE50"]);
    await handleReceiptVerdict(c, verdict("r436", { amount: 43.6 }));
    expect((grantCourses.mock.calls[0][1] as { grant: string[] }).grant).toEqual(["COURSE50"]);
    const c2 = await newContact("d6");
    const r = await db.receiptCheck.create({
      data: { contactId: c2.id, kind: "suspicious", confidence: 90, reason: "r", imageHash: "p44", amount: 44, ownerDecision: "PENDING" },
    });
    grantCourses.mockResolvedValueOnce(["COURSE50"]);
    await decideReceipt(r.id, "approve");
    expect((grantCourses.mock.calls[1][1] as { grant: string[] }).grant).toEqual(["COURSE50"]);
  });
});

describe("настоящая база: ревью 5", () => {
  it("недоплата 40 после 'Подтвердить': нужен явный выбор курса, ссылка 'выше' не обещается", async () => {
    const c = await newContact("e1");
    const r = await db.receiptCheck.create({
      data: { contactId: c.id, kind: "suspicious", confidence: 90, reason: "r", imageHash: "u40", amount: 40, ownerDecision: "PENDING" },
    });
    const first = await decideReceipt(r.id, "approve");
    expect(first).toMatchObject({ ok: false, reason: "needs_course" });
    expect((await db.receiptCheck.findUnique({ where: { id: r.id } }))?.ownerDecision).toBe("PENDING");
    grantCourses.mockResolvedValueOnce(["COURSE50"]);
    const chosen = await decideReceipt(r.id, "approve", "COURSE50");
    expect(chosen).toMatchObject({ ok: true, status: "approved" });
  });

  it("недоплата 40: в карточке вместо 'Подтвердить' выбор курса", async () => {
    const c = await newContact("e2");
    await handleReceiptVerdict(c, verdict("c40", { amount: 40 }));
    expect((sendReceiptForReview.mock.calls[0][2] as { needsCourseChoice: boolean }).needsCourseChoice).toBe(true);
  });

  it("второй платёж, пока вопрос про Telegram ждёт ответа: клиентке уходит напоминание", async () => {
    const c = await db.contact.create({ data: { id: "e3", igUserId: "ig-e3", username: "e3", deliveryChoicePromptState: "WAITING" } });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true } });
    // выдача идёт через настоящий deferGrantForChoice (как в боевом grantCourses) внутри области принятого чека
    grantCourses.mockImplementationOnce(async (cc: unknown, plan: unknown, amt: unknown, v: unknown) => {
      await deferGrantForChoice(cc as never, plan as never, amt as number, v as never, { purpose: "verified_receipt_access" });
      return [];
    });
    await handleReceiptVerdict(c, verdict("p50", { amount: 50 }));
    expect(sendToContact.mock.calls.map((x) => String(x[1])).join(" ")).toMatch(/Telegram/);
  });

  it("курс 50 куплен, но не доставлен: карточка честно 'откроет Арт-десерты', не 'дубль'", async () => {
    const c = await newContact("e4");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE50", amount: 50, source: "RECEIPT" } });
    await handleReceiptVerdict(c, verdict("r50", { amount: 50, tamperingSuspected: true }));
    const args = sendReceiptForReview.mock.calls[0][2] as { caption: string; closeAsDuplicate: boolean };
    expect(args.closeAsDuplicate).toBe(false);
    expect(args.caption).toMatch(/Подтвердить откроет: Арт-десерты/);
  });

  it("курс 70 отозван, чек на 70: карточка говорит про отзыв, не обещает курс", async () => {
    const c = await newContact("e5");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, revokedAt: new Date(), inviteLink: "https://x/l/abc" } });
    await handleReceiptVerdict(c, verdict("r70", { amount: 70, tamperingSuspected: true }));
    const args = sendReceiptForReview.mock.calls[0][2] as { caption: string };
    expect(args.caption).toMatch(/отозван/);
  });
});

describe("настоящая база: ревью PR 72", () => {
  it("после напоминания номер вопроса обновлён: короткое 'да' будет засчитано", async () => {
    const c = await db.contact.create({ data: { id: "f1", igUserId: "ig-f1", username: "f1", deliveryChoicePromptState: "WAITING", deliveryChoicePromptMid: "mid-old" } });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true } });
    // выдача идёт через настоящий deferGrantForChoice (как в боевом grantCourses) внутри области принятого чека
    grantCourses.mockImplementationOnce(async (cc: unknown, plan: unknown, amt: unknown, v: unknown) => {
      await deferGrantForChoice(cc as never, plan as never, amt as number, v as never, { purpose: "verified_receipt_access" });
      return [];
    });
    await handleReceiptVerdict(c, verdict("f1-50", { amount: 50 }));
    const fresh = await db.contact.findUnique({ where: { id: c.id } });
    const lastOut = await db.message.findFirst({ where: { contactId: c.id, direction: "OUT" }, orderBy: { createdAt: "desc" } });
    expect(fresh?.deliveryChoicePromptMid).toBeTruthy();
    expect(fresh?.deliveryChoicePromptMid).not.toBe("mid-old");
    expect(lastOut?.mid).toBe(fresh?.deliveryChoicePromptMid);
  });

  it("курс 50 выдан руками, чек 70: покупка 70 записана на полную сумму 70, а не 35", async () => {
    const c = await newContact("f2");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE50", amount: 50, inviteLink: "https://x/l/m", source: "MANUAL" } });
    await deferGrantForChoice(c, { grant: ["COURSE50", "COURSE70"], note: "n" }, 70, { amount: 70, currency: "TJS" }, {});
    const p70 = await db.purchase.findUnique({ where: { contactId_course: { contactId: c.id, course: "COURSE70" } } });
    expect(p70?.amount).toBe(70);
  });

  it("чек 40 + выбор курса 50: в покупку идёт сумма чека 40, не цена курса", async () => {
    const c = await newContact("f3");
    const r = await db.receiptCheck.create({ data: { contactId: c.id, kind: "suspicious", confidence: 80, reason: "r", imageHash: "f3", amount: 40, ownerDecision: "PENDING" } });
    grantCourses.mockResolvedValueOnce(["COURSE50"]);
    await decideReceipt(r.id, "approve", "COURSE50");
    expect(grantCourses.mock.calls[0][2]).toBe(40);
  });

  it("ссылка Ширин сняла вопрос: курс помечен выданным вручную и не считается недоставленным", async () => {
    const c = await newContact("f4");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true } });
    await db.message.create({ data: { contactId: c.id, direction: "OUT", byHuman: true, text: "Вот https://shirinsweets.online/l/aBcD234567" } });
    expect(await settleChoiceIfHandedOut(c.id)).toBe(true);
    const plan = await planForAmount(c.id, 70);
    expect(plan.grant).toEqual([]);
    expect(plan.duplicate).toBe(true);
    expect(plan.retry).toEqual([]);
  });

  it("первый вопрос про Telegram не дошёл (FAILED): второй чек не тонет в тишине", async () => {
    const c = await db.contact.create({ data: { id: "f5", igUserId: "ig-f5", username: "f5", deliveryChoicePromptState: "FAILED" } });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true } });
    // выдача идёт через настоящий deferGrantForChoice (как в боевом grantCourses) внутри области принятого чека
    grantCourses.mockImplementationOnce(async (cc: unknown, plan: unknown, amt: unknown, v: unknown) => {
      await deferGrantForChoice(cc as never, plan as never, amt as number, v as never, { purpose: "verified_receipt_access" });
      return [];
    });
    await handleReceiptVerdict(c, verdict("f5-50", { amount: 50 }));
    expect(sendToContact.mock.calls.map((x) => String(x[1])).join(" ")).toMatch(/Telegram/);
  });

  it("отозван курс 70, чек 70, 'Подтвердить': ответ про отзыв, а не 'дубль'", async () => {
    const c = await newContact("f6");
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, revokedAt: new Date(), inviteLink: "https://x/l/a" } });
    const r = await db.receiptCheck.create({ data: { contactId: c.id, kind: "suspicious", confidence: 80, reason: "r", imageHash: "f6", amount: 70, ownerDecision: "PENDING" } });
    const res = await decideReceipt(r.id, "approve");
    expect(String((res as { message: string }).message)).toMatch(/отозван/);
  });
});

describe("настоящая база: ревью PR 72 (2)", () => {
  it("вопрос уже задавали, платёж подтверждён владельцем: клиентке уходит напоминание, не тишина", async () => {
    const c = await db.contact.create({ data: { id: "g1", igUserId: "ig-g1", username: "g1", deliveryChoicePromptState: "WAITING", deliveryChoicePromptMid: "old-q" } });
    await deferGrantForChoice(c, { grant: ["COURSE70"], note: "n" }, 70, { amount: 70, currency: "TJS" }, {});
    expect(sendToContact.mock.calls.map((x) => String(x[1])).join(" ")).toMatch(/Telegram/);
    const fresh = await db.contact.findUnique({ where: { id: c.id } });
    expect(fresh?.deliveryChoicePromptMid).not.toBe("old-q");
  });

  it("после служебных сообщений бота короткое 'да' засчитывается; после обычной реплики или Ширин - нет", async () => {
    const c = await newContact("g2");
    const t0 = Date.now() - 60_000;
    await db.message.create({ data: { contactId: c.id, direction: "OUT", mid: "q1", text: "Шумо Telegram доред?", createdAt: new Date(t0) } });
    await db.message.create({ data: { contactId: c.id, direction: "OUT", mid: "s1", text: "Чекро гирифтам, ба Ширин барои тафтиш медиҳам.", createdAt: new Date(t0 + 1000) } });
    await db.message.create({ data: { contactId: c.id, direction: "OUT", mid: "s2", text: "Этот перевод мы уже приняли — ссылка на уроки выше в этом чате.", createdAt: new Date(t0 + 2000) } });
    expect(await lastBotMessageIsQuestionOrService(c.id, "q1")).toBe(true);
    await db.message.create({ data: { contactId: c.id, direction: "OUT", mid: "x1", text: "Курс стоит 70 сомони", createdAt: new Date(t0 + 3000) } });
    expect(await lastBotMessageIsQuestionOrService(c.id, "q1")).toBe(false);
    expect(await lastBotMessageIsQuestionOrService(c.id, null)).toBe(false);
  });

  it("выдан вручную курс 50, потом пришёл чек 70: ожидание по 50 снимается, по 70 остаётся", async () => {
    const c = await newContact("g3");
    const t0 = Date.now() - 20 * 60_000;
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE50", amount: 50, deliveryAwaitingChoice: true, createdAt: new Date(t0) } });
    await db.message.create({ data: { contactId: c.id, direction: "OUT", byHuman: true, text: "Ваша ссылка https://shirinsweets.online/l/aBcD234567", createdAt: new Date(t0 + 60_000) } });
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true, createdAt: new Date(t0 + 10 * 60_000) } });
    await settleChoiceIfHandedOut(c.id);
    const p50 = await db.purchase.findUnique({ where: { contactId_course: { contactId: c.id, course: "COURSE50" } } });
    const p70 = await db.purchase.findUnique({ where: { contactId_course: { contactId: c.id, course: "COURSE70" } } });
    expect(p50?.deliveryAwaitingChoice).toBe(false);
    expect(p70?.deliveryAwaitingChoice).toBe(true);
  });

  it("деление суммы одно: 121 на двоих = 60 + 61 и в выдаче, и в ожидании выбора", async () => {
    expect(splitAmount(121, 2)).toEqual([60, 61]);
    const c = await newContact("g4");
    await deferGrantForChoice(c, { grant: ["COURSE50", "COURSE70"], note: "n" }, 121, { amount: 121, currency: "TJS" }, {});
    const rows = await db.purchase.findMany({ where: { contactId: c.id } });
    expect(rows.map((r) => r.amount).sort()).toEqual([60, 61]);
  });
});
