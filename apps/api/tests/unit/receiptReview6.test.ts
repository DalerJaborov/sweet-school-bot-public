import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * НЕЗАВИСИМОЕ РЕВЬЮ PR 72 (15.11.2026), НАСТОЯЩАЯ SQLITE.
 *  1. Ручная ссылка Ширин закрывает только ТОТ курс, в который ведёт.
 *  2. Пересланная дважды ссылка - одна ссылка; длинная переписка не теряет свежую.
 *  3. Ручная запись из панели и ручная выдача - не «недоставленная» покупка.
 *  4. Код валюты с пробелами - всё ещё сомони.
 *  5. Ширин ведёт разговор, сумма ни к чему: в карточке выбор курса.
 *  6. Кнопка Ширин и разбор чека одного человека не выдают параллельно.
 */
let midCounter = 0;
const sendToContact = vi.fn(async (..._a: unknown[]) => `mid-${++midCounter}`);
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => ({ chatId: "owner-1", messageId: 5 }));
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["tech-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  chatsForKind: vi.fn(async () => ["tech-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  editCaption: vi.fn(async () => undefined),
}));
let active = 0;
let maxActive = 0;
const grantCourses = vi.fn(async (_c: unknown, plan: { grant: string[] }) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, 80));
  active -= 1;
  return plan.grant;
});
vi.mock("../../src/ai.js", () => ({
  grantCourses: (...a: unknown[]) => grantCourses(...(a as [unknown, { grant: string[] }])),
}));
vi.mock("../../src/ai/grantCourses.js", () => ({
  grantCourses: (...a: unknown[]) => grantCourses(...(a as [unknown, { grant: string[] }])),
}));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
const toSomoni = vi.fn(async (amount: number): Promise<number | null> => amount);
vi.mock("../../src/exchangeRates.js", () => ({ toSomoni: (...a: unknown[]) => toSomoni(...(a as [number])) }));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { settleChoiceIfHandedOut } from "../../src/course/handedOut.js";
import { awaitsBotDelivery, planForAmount } from "../../src/courses.js";
import { decideReceipt } from "../../src/receiptDecision.js";
import { resetPriceCache } from "../../src/services/priceService.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-review6-"));
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

const GROUP50 = "-100500";
const GROUP70 = "-100700";

beforeEach(async () => {
  resetPriceCache();
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  sendTelegramMessage.mockClear();
  grantCourses.mockClear();
  active = 0;
  maxActive = 0;
  for (const t of ["receiptCheck", "purchase", "message", "telegramInvite", "contact", "setting"] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.createMany({
    data: [
      { key: "telegramBotToken", value: "tok" },
      { key: "telegramChatId50", value: GROUP50 },
      { key: "telegramChatId70", value: GROUP70 },
    ],
  });
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function newContact(id: string, data: Record<string, unknown> = {}) {
  return db.contact.create({ data: { id, igUserId: `ig-${id}`, username: id, ...data } });
}

async function invite(link: string, chatId: string, contactId: string | null = null) {
  await db.telegramInvite.create({
    data: { groupKey: chatId === GROUP50 ? "COURSE50" : "COURSE70", chatId, inviteLink: link, contactId },
  });
}

async function shirinSays(contactId: string, text: string, at: Date) {
  await db.message.create({ data: { contactId, direction: "OUT", byHuman: true, text, createdAt: at } });
}

async function bothWaiting(contactId: string) {
  await db.purchase.create({
    data: { contactId, course: "COURSE50", amount: 50, deliveryAwaitingChoice: true, createdAt: minutesAgo(30) },
  });
  await db.purchase.create({
    data: { contactId, course: "COURSE70", amount: 70, deliveryAwaitingChoice: true, createdAt: minutesAgo(29) },
  });
}

const purchase = (contactId: string, course: string) =>
  db.purchase.findUnique({ where: { contactId_course: { contactId, course } } });

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

describe("1-2. ручная ссылка Ширин закрывает только свой курс", () => {
  it("купила оба, Ширин прислала группу «Арт-десерты»: закрыта покупка 50, «21 рецепт» ждёт", async () => {
    const c = await newContact("a1");
    await bothWaiting(c.id);
    await invite("https://t.me/+Group50Link", GROUP50);
    await shirinSays(c.id, "Вот группа https://t.me/+Group50Link", minutesAgo(5));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
    expect(await purchase(c.id, "COURSE50")).toMatchObject({ deliveryAwaitingChoice: false, inviteLink: null });
    expect((await purchase(c.id, "COURSE50"))?.accessIssuedAt).not.toBeNull();
    expect(await purchase(c.id, "COURSE70")).toMatchObject({ deliveryAwaitingChoice: true, accessIssuedAt: null });
    // курс 70 по-прежнему ждёт бота: вопрос про Telegram задастся заново
    expect((await db.contact.findUnique({ where: { id: c.id } }))?.deliveryChoicePromptState).toBeNull();

    // потом Ширин прислала группу 70 - закрыто всё
    await invite("https://t.me/+Group70Link", GROUP70);
    await shirinSays(c.id, "И вторая t.me/+Group70Link", minutesAgo(2));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(true);
    expect((await purchase(c.id, "COURSE70"))?.deliveryAwaitingChoice).toBe(false);
  });

  it("одна и та же ссылка в группу 50, пересланная дважды, не закрывает покупку 70", async () => {
    const c = await newContact("a2");
    await bothWaiting(c.id);
    await invite("https://t.me/+Group50Link", GROUP50);
    await shirinSays(c.id, "https://t.me/+Group50Link", minutesAgo(5));
    await shirinSays(c.id, "ещё раз: https://t.me/+Group50Link", minutesAgo(4));
    await settleChoiceIfHandedOut(c.id);
    await settleChoiceIfHandedOut(c.id);
    expect((await purchase(c.id, "COURSE70"))?.deliveryAwaitingChoice).toBe(true);
  });

  it("незнакомая ссылка (создана в самом Telegram): ничего не закрывает, Далеру одна строка, без повторов", async () => {
    const c = await newContact("a3");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE70",
        amount: 70,
        deliveryAwaitingChoice: true,
        createdAt: minutesAgo(30),
      },
    });
    await shirinSays(c.id, "Группа https://t.me/+MadeInTelegram1", minutesAgo(5));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
    expect((await purchase(c.id, "COURSE70"))?.deliveryAwaitingChoice).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toMatch(/не узнал.*21 рецепт/s);
  });

  it("приглашение, выданное ДРУГОМУ человеку, не закрывает покупку", async () => {
    const c = await newContact("a4");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE70",
        amount: 70,
        deliveryAwaitingChoice: true,
        createdAt: minutesAgo(30),
      },
    });
    await invite("https://t.me/+ForSomeoneElse", GROUP70, "other-contact");
    await shirinSays(c.id, "https://t.me/+ForSomeoneElse", minutesAgo(5));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
    expect((await purchase(c.id, "COURSE70"))?.deliveryAwaitingChoice).toBe(true);
  });

  it("личная ссылка сайта ЭТОГО человека открывает все курсы: закрывает обе покупки", async () => {
    const c = await newContact("a5", { accessTokenId: "PersonalCode123" });
    await bothWaiting(c.id);
    await shirinSays(c.id, "Ваши уроки: https://shirinsweets.online/l/PersonalCode123", minutesAgo(5));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(true);
  });

  it("чужая личная ссылка сайта не закрывает ничего", async () => {
    await newContact("other", { accessTokenId: "OtherPerson999" });
    const c = await newContact("a6");
    await bothWaiting(c.id);
    await shirinSays(c.id, "https://shirinsweets.online/l/OtherPerson999", minutesAgo(5));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
    expect(await db.purchase.count({ where: { contactId: c.id, deliveryAwaitingChoice: true } })).toBe(2);
  });

  it("ссылка, присланная ДО покупки, её не закрывает", async () => {
    const c = await newContact("a7", { accessTokenId: "PersonalCode777" });
    await shirinSays(c.id, "https://shirinsweets.online/l/PersonalCode777", minutesAgo(60));
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE70",
        amount: 70,
        deliveryAwaitingChoice: true,
        createdAt: minutesAgo(30),
      },
    });
    expect(await settleChoiceIfHandedOut(c.id)).toBe(false);
  });

  it("длинная переписка: 120 сообщений Ширин, потом ссылка - покупка закрывается", async () => {
    const c = await newContact("a8");
    await db.purchase.create({
      data: {
        contactId: c.id,
        course: "COURSE70",
        amount: 70,
        deliveryAwaitingChoice: true,
        createdAt: minutesAgo(300),
      },
    });
    await db.message.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        contactId: c.id,
        direction: "OUT",
        byHuman: true,
        text: `Сообщение ${i}`,
        createdAt: minutesAgo(250 - i),
      })),
    });
    await invite("https://t.me/+Group70Late", GROUP70);
    await shirinSays(c.id, "https://t.me/+Group70Late", minutesAgo(10));
    expect(await settleChoiceIfHandedOut(c.id)).toBe(true);
  });
});

describe("3. ручная запись и ручная выдача - уже доставлены", () => {
  it("одно понятие «боту ещё доставлять»", () => {
    const base = { inviteLink: null, accessIssuedAt: null, revokedAt: null };
    expect(awaitsBotDelivery({ ...base, source: "RECEIPT" })).toBe(true);
    expect(awaitsBotDelivery({ ...base, source: "MANUAL" })).toBe(false);
    expect(awaitsBotDelivery({ ...base, source: "RECEIPT", accessIssuedAt: new Date() })).toBe(false);
    expect(awaitsBotDelivery({ ...base, source: "RECEIPT", inviteLink: "x" })).toBe(false);
    expect(awaitsBotDelivery({ ...base, source: "RECEIPT", revokedAt: new Date() })).toBe(false);
  });

  it("курс 70 записан вручную из панели, пришёл чек 70: карточка - «уже есть», «Подтвердить» второй ссылки не шлёт", async () => {
    const c = await newContact("m1", { paid: true, paidAt: minutesAgo(60 * 24) });
    await db.purchase.create({
      data: { contactId: c.id, course: "COURSE70", amount: 70, source: "MANUAL", createdAt: minutesAgo(60 * 24) },
    });
    const plan = await planForAmount(c.id, 70);
    expect(plan).toMatchObject({ grant: [], retry: [], duplicate: true });

    await handleReceiptVerdict(c, verdict("m1"));
    expect(grantCourses).not.toHaveBeenCalled();
    const caption = String((sendReceiptForReview.mock.calls[0]?.[2] as { caption?: string }).caption);
    expect(caption).toMatch(/курс по этой сумме у клиентки уже есть/);

    const row = await db.receiptCheck.findUnique({ where: { imageHash: "m1" } });
    const res = await decideReceipt(row!.id, "approve");
    expect(res).toMatchObject({ ok: true, status: "approved_no_link" });
    expect(grantCourses).not.toHaveBeenCalled();
  });

  it("чек закрыт молча после ручной ссылки Ширин: покупка помечена «выдано вручную», кнопка повтор не шлёт", async () => {
    const c = await newContact("m2");
    const queued = await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "unchecked",
        confidence: 0,
        reason: "в очереди",
        imageHash: "m2",
        createdAt: minutesAgo(30),
      },
    });
    await shirinSays(c.id, "Вот группа https://t.me/+NotFromPanel1", minutesAgo(10));
    await handleReceiptVerdict(c, verdict("m2"), queued.id);
    expect(grantCourses).not.toHaveBeenCalled();
    const p = await purchase(c.id, "COURSE70");
    expect(p).toMatchObject({ inviteLink: null });
    expect(p?.accessIssuedAt).not.toBeNull();
    expect(await planForAmount(c.id, 70)).toMatchObject({ grant: [], retry: [] });
  });
});

describe("4-5. мелочи разбора", () => {
  it("валюта « tjs » - это сомони: 66 проходит по допуску 6, курс валют не нужен", async () => {
    const c = await newContact("s1");
    await handleReceiptVerdict(c, verdict("s1", { amount: 66, currency: " tjs " }));
    expect(toSomoni).not.toHaveBeenCalled();
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("Ширин ведёт разговор, сумма ни к одному курсу: в карточке выбор курса, а не «Подтвердить»", async () => {
    const c = await newContact("s2", {
      humanTakenOverAt: new Date(),
      humanSilencedUntil: new Date(Date.now() + 3_600_000),
    });
    await handleReceiptVerdict(c, verdict("s2", { amount: 40 }));
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview.mock.calls[0][2]).toMatchObject({ needsCourseChoice: true });
  });
});

describe("6. одна очередь на человека", () => {
  it("кнопка Ширин и разбор нового чека того же человека не выдают одновременно", async () => {
    const c = await newContact("q1");
    const pending = await db.receiptCheck.create({
      data: {
        contactId: c.id,
        kind: "suspicious",
        confidence: 90,
        reason: "смотрите",
        imageHash: "q1-old",
        amount: 50,
        ownerDecision: "PENDING",
      },
    });
    await Promise.all([handleReceiptVerdict(c, verdict("q1-new")), decideReceipt(pending.id, "approve")]);
    expect(grantCourses).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});
