import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * РЕШЕНИЕ ВЛАДЕЛЬЦА Q20 (15.11.2026), НАСТОЯЩАЯ SQLITE.
 *  а) Уже покупала раньше + чек без даты И без номера операции: ссылку бот сам
 *     не выдаёт, чек - Ширин с кнопкой, клиентке - «передаю на проверку».
 *  б) Чек в рублях (и любой не-сомони валюте): недобор до цены не больше 5% от
 *     цены после перевода по курсу; для сомони прежний допуск 6.
 * Отправка клиенту, Telegram, выдача курса и курс валют - заглушки.
 */
let midCounter = 0;
const sendToContact = vi.fn(async (..._a: unknown[]) => `mid-${++midCounter}`);
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => ({ chatId: "owner-1", messageId: 5 }));
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: vi.fn(async () => 1),
  editCaption: vi.fn(async () => undefined),
}));
const grantCourses = vi.fn(async (_c: unknown, plan: { grant: string[] }) => plan.grant);
vi.mock("../../src/ai.js", () => ({
  grantCourses: (...a: unknown[]) => grantCourses(...(a as [unknown, { grant: string[] }])),
}));
vi.mock("../../src/ai/grantCourses.js", () => ({
  grantCourses: (...a: unknown[]) => grantCourses(...(a as [unknown, { grant: string[] }])),
}));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
const toSomoni = vi.fn(async (amount: number, _currency: string | null | undefined): Promise<number | null> => amount);
vi.mock("../../src/exchangeRates.js", () => ({
  toSomoni: (...a: unknown[]) => toSomoni(...(a as [number, string])),
}));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { resetPriceCache, getPaymentTolerance } from "../../src/services/priceService.js";
import { foreignShortfallOk } from "../../src/courses.js";
import { parseOffer, OFFER_DEFAULTS } from "../../src/services/offerService.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-q20-"));
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
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  grantCourses.mockClear();
  toSomoni.mockReset();
  toSomoni.mockImplementation(async (amount: number) => amount);
  for (const t of ["receiptCheck", "purchase", "message", "contact", "setting"] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.create({ data: { key: "telegramBotToken", value: "tok" } });
});

async function newContact(id: string, data: Record<string, unknown> = {}) {
  return db.contact.create({ data: { id, igUserId: `ig-${id}`, username: id, ...data } });
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

const noDateNoTxn = { receiptAt: null, transactionId: null };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Что ушло клиентке текстом (второй аргумент sendToContact). */
const sentTexts = () => sendToContact.mock.calls.map((c) => String(c[1]));
const ownerCaption = () =>
  String((sendReceiptForReview.mock.calls[0]?.[2] as { caption?: string } | undefined)?.caption ?? "");

describe("Q20 а: уже покупала + чек без даты и без номера операции", () => {
  it("новая клиентка: такой чек проходит сам (ссылка уходит, Ширин не зовём)", async () => {
    const c = await newContact("new1");
    await handleReceiptVerdict(c, verdict("n1", noDateNoTxn));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    const row = await db.receiptCheck.findUnique({ where: { imageHash: "n1" } });
    expect(row).toMatchObject({ linkSent: true, ownerDecision: null });
  });

  it("действующий курс 50: ссылку не выдаём, карточка Ширин с «Подтвердить», клиентке «передаю на проверку»", async () => {
    const c = await newContact("r1");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE50",
        amount: 50,
        inviteLink: "https://t.me/+old",
        createdAt: minutesAgo(60 * 24 * 30),
      },
    });
    await handleReceiptVerdict(c, verdict("r1", noDateNoTxn));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    // Кнопка «Подтвердить» (а не выбор курса): сумма понятна - курс 70.
    expect(sendReceiptForReview.mock.calls[0][2]).toMatchObject({ needsCourseChoice: false });
    expect(ownerCaption()).toMatch(/уже покупала/);
    expect(ownerCaption()).toMatch(/Подтвердить откроет: 21 рецепт/);
    const row = await db.receiptCheck.findUnique({ where: { imageHash: "r1" } });
    expect(row).toMatchObject({ linkSent: false, ownerDecision: "PENDING", kind: "valid" });
    expect(row?.customerNotifiedAt).not.toBeNull();
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toMatch(/передаю Ширин на проверку/);
    // Без «ты»-обращения: ответ нейтральный, на «вы».
    expect(sentTexts()[0]).not.toMatch(/\b(ты|тебе|твой|пришли)\b/i);
  });

  it("курс был, но доступ отозван: тоже «покупала раньше» - к Ширин", async () => {
    const c = await newContact("r2");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE50",
        amount: 50,
        revokedAt: minutesAgo(60),
        createdAt: minutesAgo(60 * 24 * 10),
      },
    });
    await handleReceiptVerdict(c, verdict("r2", noDateNoTxn));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("покупки в базе нет, но клиентка отмечена «оплатила» (ручная выдача): к Ширин", async () => {
    const c = await newContact("r3", { paid: true, paidAt: minutesAgo(60 * 24 * 5) });
    await handleReceiptVerdict(c, verdict("r3", noDateNoTxn));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("раньше принятый чек (ссылку дала Ширин), покупки нет: к Ширин", async () => {
    const c = await newContact("r4");
    await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "valid",
        confidence: 90,
        reason: "ok",
        imageHash: "old-r4",
        amount: 50,
        ownerDecision: "HANDLED",
        createdAt: minutesAgo(60 * 24 * 20),
      },
    });
    await handleReceiptVerdict(c, verdict("r4", noDateNoTxn));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("покупавшая клиентка, но на чеке есть номер операции: проходит сам", async () => {
    const c = await newContact("r5");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE50",
        amount: 50,
        inviteLink: "https://t.me/+old",
        createdAt: minutesAgo(60 * 24 * 30),
      },
    });
    await handleReceiptVerdict(c, verdict("r5", { receiptAt: null, transactionId: "TXN-778899" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });

  it("покупавшая клиентка, на чеке есть дата: проходит сам", async () => {
    const c = await newContact("r6");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE50",
        amount: 50,
        inviteLink: "https://t.me/+old",
        createdAt: minutesAgo(60 * 24 * 30),
      },
    });
    await handleReceiptVerdict(c, verdict("r6", { transactionId: null }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });

  it("перепроверка из очереди: покупка, созданная ПОСЛЕ этого чека, не делает клиентку «покупавшей раньше»", async () => {
    const c = await newContact("r7");
    const queued = await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "unchecked",
        confidence: 0,
        reason: "в очереди",
        imageHash: "r7",
        createdAt: minutesAgo(30),
      },
    });
    // Курс 50 куплен позже, другим путём (не этим чеком) - чек на 70 без даты пришёл раньше.
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE50",
        amount: 50,
        inviteLink: "https://t.me/+x",
        createdAt: minutesAgo(10),
      },
    });
    await handleReceiptVerdict(c, verdict("r7", noDateNoTxn), queued.id);
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });
});

describe("ревью PR 72: гонка и деление суммы", () => {
  it("тот же скриншот дважды одновременно: выдача одна, второй разбор видит первый", async () => {
    const c = await newContact("race1");
    grantCourses.mockImplementationOnce(async (_c, plan) => {
      await new Promise((r) => setTimeout(r, 150));
      return plan.grant;
    });
    await Promise.all([handleReceiptVerdict(c, verdict("race")), handleReceiptVerdict(c, verdict("race"))]);
    expect(grantCourses).toHaveBeenCalledTimes(1);
    const rows = await db.receiptCheck.findMany({ where: { contactId: c.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ linkSent: true });
  });

  it("ошибка в одном разборе не держит очередь человека", async () => {
    const c = await newContact("race2");
    grantCourses.mockImplementationOnce(async () => {
      throw new Error("сбой сети");
    });
    await expect(handleReceiptVerdict(c, verdict("boom"))).rejects.toThrow("сбой сети");
    await handleReceiptVerdict(c, verdict("after", { amount: 50 }));
    expect(grantCourses).toHaveBeenCalledTimes(2);
  });

  it("сторож: сумма делится между курсами только через splitAmount", () => {
    const root = path.join(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /amount\s*\/\s*[\w.]+\.length/i.test(fs.readFileSync(p, "utf8")))
          offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("Q20 б: чек в рублях - допуск 5% от цены", () => {
  it("640 ₽ ≈ 67 сомони за курс 70 (меньше на 4.3%): проходит сам", async () => {
    const c = await newContact("f1");
    toSomoni.mockResolvedValue(67);
    await handleReceiptVerdict(c, verdict("f1", { amount: 640, currency: "RUB" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
  });

  it("≈ 66 сомони за курс 70 (меньше на 5.7%): к Ширин, хотя для сомони 66 прошло бы (допуск 6)", async () => {
    const c = await newContact("f2");
    toSomoni.mockResolvedValue(66);
    await handleReceiptVerdict(c, verdict("f2", { amount: 600, currency: "RUB" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(ownerCaption()).toMatch(/чек в RUB/);
    // Кнопка Ширин считает по обычному допуску: «Подтвердить» откроет курс 70.
    expect(ownerCaption()).toMatch(/Подтвердить откроет: 21 рецепт/);
    expect(sentTexts().some((t) => /передаю Ширин/.test(t))).toBe(true);
  });

  it("сомони: 66 за курс 70 по-прежнему проходит сам (допуск 6 сомони не тронут)", async () => {
    const c = await newContact("f3");
    await handleReceiptVerdict(c, verdict("f3", { amount: 66, currency: "TJS" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(toSomoni).not.toHaveBeenCalled();
  });

  it("ровно 66.5 сомони (5%) за курс 70: граница включительно, проходит", async () => {
    const c = await newContact("f4");
    toSomoni.mockResolvedValue(66.5);
    await handleReceiptVerdict(c, verdict("f4", { amount: 605, currency: "RUB" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("комплект: 94.5 сомони за 100 - к Ширин (а не тихо один курс), 96 - оба курса сами", async () => {
    const a = await newContact("f5a");
    toSomoni.mockResolvedValue(94.5);
    await handleReceiptVerdict(a, verdict("f5a", { amount: 860, currency: "RUB" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);

    const b = await newContact("f5b");
    toSomoni.mockResolvedValue(96);
    await handleReceiptVerdict(b, verdict("f5b", { amount: 875, currency: "RUB" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect((grantCourses.mock.calls[0][1] as { grant: string[] }).grant.sort()).toEqual(["COURSE50", "COURSE70"]);
  });

  it("доллары и другая валюта - то же правило процента", async () => {
    const c = await newContact("f6");
    toSomoni.mockResolvedValue(66);
    await handleReceiptVerdict(c, verdict("f6", { amount: 6.2, currency: "USD" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(ownerCaption()).toMatch(/чек в USD/);
  });

  it("процент из настроек: 10% пропускает 64 сомони за курс 70", async () => {
    await db.setting.create({ data: { key: "receiptToleranceForeignPct", value: "10" } });
    const c = await newContact("f7");
    toSomoni.mockResolvedValue(64);
    await handleReceiptVerdict(c, verdict("f7", { amount: 580, currency: "RUB" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("мусор и значения за пределом в настройке - берётся 5%", async () => {
    for (const value of ["50", "-1", "abc", ""]) {
      await db.setting.deleteMany({ where: { key: "receiptToleranceForeignPct" } });
      await db.setting.create({ data: { key: "receiptToleranceForeignPct", value } });
      expect((await getPaymentTolerance()).foreignPct).toBe(5);
    }
  });

  it("ворота считают цель выдачи: один курс - его цена, два - цена комплекта", async () => {
    expect(await foreignShortfallOk(47.5, ["COURSE50"])).toMatchObject({ ok: true, price: 50, minimum: 47.5 });
    expect(await foreignShortfallOk(47.4, ["COURSE50"])).toMatchObject({ ok: false });
    expect(await foreignShortfallOk(95, ["COURSE50", "COURSE70"])).toMatchObject({ ok: true, price: 100 });
    expect(await foreignShortfallOk(100, [])).toMatchObject({ ok: false });
  });

  it("«Цены и даты»: процент проверяется (0..10, целое), без поля форма валидна", () => {
    const ok = parseOffer({
      ...OFFER_DEFAULTS,
      payment: { toleranceDown: 6, toleranceUp: 30, toleranceForeignPct: 7 },
    });
    expect("offer" in ok && ok.offer.payment?.toleranceForeignPct).toBe(7);
    const tooBig = parseOffer({
      ...OFFER_DEFAULTS,
      payment: { toleranceDown: 6, toleranceUp: 30, toleranceForeignPct: 11 },
    });
    expect("errors" in tooBig && tooBig.errors["payment.toleranceForeignPct"]).toMatch(/недоплата/);
    const legacy = parseOffer({ ...OFFER_DEFAULTS, payment: { toleranceDown: 6, toleranceUp: 30 } });
    expect("offer" in legacy).toBe(true);
  });
});
