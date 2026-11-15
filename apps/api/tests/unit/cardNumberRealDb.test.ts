import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient, type Contact } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * НОМЕР КАРТЫ СРАЗУ, ГОТОВЫЕ ВОПРОСЫ, «ЗАВТРА ПЕРЕВЕДУ», ЦИФРА В СВОДКЕ — на
 * настоящей SQLite (разбор 16.11.2026). Заглушены только отправка клиенту и
 * Telegram: расписание воронки, захват номера и выборки проверяет сама база.
 */
let sendSeq = 0;
const sendToContact = vi.fn(async (..._a: unknown[]) => `mid-${++sendSeq}` as string | null);
vi.mock("../../src/messaging/send.js", () => ({
  sendToContact: (...a: unknown[]) => sendToContact(...a),
  sendAttachmentToContact: vi.fn(async () => "att"),
  sendPrivateReplyRecorded: vi.fn(async () => "pr"),
}));
const notifyOwnerDirect = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../src/systemAlerts.js", () => ({
  notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a),
  notifyFunnelGaveUp: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({ aiReplyToComment: vi.fn(async () => "ai") }));

import { handleIncomingDm, handleQuickReply, cancelPendingFunnelSteps, runDueDeliveries } from "../../src/funnel.js";
import { applyRequisitesOffer } from "../../src/ai/requisitesOffer.js";
import { resetRequisitesClaims } from "../../src/ai/repeatGuard.js";
import { resetSalesTextsCache } from "../../src/services/salesTextsService.js";
import { runPaymentReminders, PAYMENT_REMINDER_SEED } from "../../src/paymentReminder.js";
import {
  requisitesReach,
  requisitesReachLine,
  requisitesDropped,
  alertIfRequisitesDropped,
} from "../../src/requisitesMetric.js";
import { buildReport } from "../../src/dailyReport.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-number-"));
const dbFile = path.join(dir, "test.db").replace(/\\/g, "/");
let db: PrismaClient;
const HOUR = 3_600_000;
const PHONE = /905\s?355\s?355/;
const NUMBER_STEP =
  "Нархи курс 70 сомонӣ. Рақами корт: 905 355 355 Фарангис Чаборова (Душанбе Сити, Алиф). Чекро фиристед.";
const MENU = "Ассалому алейкум! Ба шумо кадом маълумоти курсро равон кунем?";

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
  sendToContact.mockClear();
  notifyOwnerDirect.mockClear();
  resetRequisitesClaims();
  resetSalesTextsCache();
  for (const t of [
    "paymentReminder",
    "receiptCheck",
    "purchase",
    "delivery",
    "funnelStep",
    "funnel",
    "message",
    "contact",
    "setting",
  ] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.createMany({ data: [{ key: "aiEnabled", value: "true" }] });
});

const sentTexts = () => sendToContact.mock.calls.map((c) => String(c[1]));
const numberSends = () => sentTexts().filter((t) => PHONE.test(t)).length;

async function contact(over: Partial<Contact> = {}): Promise<Contact> {
  return db.contact.create({ data: { igUserId: `ig-${Math.random()}`, channel: "INSTAGRAM", ...over } });
}

/** DM-воронка как на проде: меню с тремя кнопками, ветка «21 рецепт»: видео 4+6+8 с, номер через 8 с. */
async function dmFunnel() {
  const f = await db.funnel.create({ data: { name: "DM", enabled: true, trigger: "DM" } });
  const buttons = JSON.stringify([
    { title: "❤️ОНЛАЙН АРТ ДЕСЕРТ", targetOrder: 10 },
    { title: "💚ОНЛАЙН 21 РЕЦЕПТ", targetOrder: 20 },
    { title: "🏠ДАР НАЗДИ МАН", targetOrder: 30 },
  ]);
  await db.funnelStep.createMany({
    data: [
      { funnelId: f.id, order: 1, text: MENU, buttons },
      { funnelId: f.id, order: 20, delaySeconds: 4, text: "Видео 1", stopAfter: false },
      { funnelId: f.id, order: 21, delaySeconds: 6, text: "Видео 2" },
      { funnelId: f.id, order: 22, delaySeconds: 8, text: "Видео 3" },
      { funnelId: f.id, order: 23, delaySeconds: 8, text: NUMBER_STEP, stopAfter: true },
      { funnelId: f.id, order: 30, text: "Офлайн", stopAfter: true },
    ],
  });
  return f;
}

/** Все шаги, которым пора, — как фоновый тик, но без ожидания секунд. */
async function runDueNow() {
  for (let i = 0; i < 10; i++) {
    await db.delivery.updateMany({ where: { state: "ACTIVE" }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    await runDueDeliveries();
    if ((await db.delivery.count({ where: { state: "ACTIVE" } })) === 0) return;
  }
}

describe("(а) кнопка «21 рецепт», вопрос через 2 секунды — номер уходит ровно один раз", () => {
  async function tappedCourse(c: Contact, f: { id: string }) {
    await handleIncomingDm(c, "Салом", null, { aiAvailable: true });
    expect((await db.delivery.findFirst({ where: { contactId: c.id } }))?.state).toBe("WAITING");
    await db.message.create({
      data: { contactId: c.id, direction: "IN", text: "💚ОНЛАЙН 21 РЕЦЕПТ", payload: `step:${f.id}:20` },
    });
    expect(await handleQuickReply(c, `step:${f.id}:20`)).toBe(true);
  }

  it("ГЛАВНОЕ: шаг с номером не отменяется, видео дальше не идут, номер один", async () => {
    const f = await dmFunnel();
    const c = await contact();
    await tappedCourse(c, f);
    sendToContact.mockClear();
    // Через 2 секунды клиент пишет сам — webhook.ts зовёт отмену с keepRequisites.
    await db.message.create({ data: { contactId: c.id, direction: "IN", text: "70 сомони за день?" } });
    await cancelPendingFunnelSteps(c.id, "остановлено: клиент написал сам", { keepRequisites: true });
    const d = await db.delivery.findFirstOrThrow({ where: { contactId: c.id } });
    expect(d.state).toBe("ACTIVE");
    expect(d.nextOrder).toBe(23);
    expect(d.stopAfterOrder).toBe(23);
    await runDueNow();
    // Ответ ИИ на вопрос приходит после шага: номер уже в истории, второй раз не добавляется.
    const offer = await applyRequisitesOffer(c.id, "70 сомони за день?", "Да, 70 сомони, доступ навсегда.", "ru");
    expect(offer.text).not.toMatch(PHONE);
    expect(numberSends()).toBe(1);
    expect(sentTexts()).not.toContain("Видео 2");
    expect(sentTexts()).not.toContain("Видео 3");
    expect((await db.delivery.findFirstOrThrow({ where: { contactId: c.id } })).state).toBe("DONE");
  });

  it("ответ ИИ успел раньше шага (цена+номер) — шаг номер не повторяет", async () => {
    const f = await dmFunnel();
    const c = await contact();
    await tappedCourse(c, f);
    sendToContact.mockClear();
    await cancelPendingFunnelSteps(c.id, "остановлено: клиент написал сам", { keepRequisites: true });
    const offer = await applyRequisitesOffer(c.id, "70 сомони за день?", "Да, 70 сомони за весь курс.", "ru");
    expect(offer.carriesRequisites).toBe(true);
    // Ответ ИИ ещё «печатается» (в историю не лёг) — шаг видит захват и молчит.
    await runDueNow();
    expect(numberSends()).toBe(0);
    expect(sentTexts()).not.toContain(NUMBER_STEP);
  });

  it("цепочка без шага с номером впереди — отменяется, как раньше", async () => {
    const f = await dmFunnel();
    await db.funnelStep.update({
      where: { funnelId_order: { funnelId: f.id, order: 23 } },
      data: { text: "Спасибо!" },
    });
    const c = await contact();
    await tappedCourse(c, f);
    await cancelPendingFunnelSteps(c.id, "остановлено: клиент написал сам", { keepRequisites: true });
    expect((await db.delivery.findFirstOrThrow({ where: { contactId: c.id } })).state).toBe("DONE");
  });

  it("Ширин ответила сама — отменяется всё, номер тоже (без keepRequisites)", async () => {
    const f = await dmFunnel();
    const c = await contact();
    await tappedCourse(c, f);
    await cancelPendingFunnelSteps(c.id, "остановлено: Ширин ответила сама");
    expect((await db.delivery.findFirstOrThrow({ where: { contactId: c.id } })).state).toBe("DONE");
  });

  it("(в) «не надо, позже» до шага — шаг с номером не навязывает", async () => {
    const f = await dmFunnel();
    const c = await contact();
    await tappedCourse(c, f);
    sendToContact.mockClear();
    await db.message.create({ data: { contactId: c.id, direction: "IN", text: "не надо, позже" } });
    await cancelPendingFunnelSteps(c.id, "остановлено: клиент написал сам", { keepRequisites: true });
    await runDueNow();
    expect(numberSends()).toBe(0);
  });

  it("повторное нажатие кнопки после «только номер» — обычная цепочка, не обрывается", async () => {
    const f = await dmFunnel();
    const c = await contact();
    await tappedCourse(c, f);
    await cancelPendingFunnelSteps(c.id, "x", { keepRequisites: true });
    await runDueNow();
    // Месяц спустя человек снова проходит воронку — stopAfterOrder не должен остаться.
    await db.delivery.updateMany({
      where: { contactId: c.id },
      data: { state: "WAITING", createdAt: new Date(Date.now() - 40 * 24 * HOUR) },
    });
    await handleQuickReply(c, `step:${f.id}:20`);
    expect((await db.delivery.findFirstOrThrow({ where: { contactId: c.id } })).stopAfterOrder).toBeNull();
  });
});

describe("(г) готовый вопрос Meta первым сообщением — таджикский ответ и меню с кнопками", () => {
  it("ГЛАВНОЕ: «Как долго доступен курс?» — ответ по-таджикски, следом меню с тремя кнопками", async () => {
    await dmFunnel();
    const c = await contact();
    await db.message.create({ data: { contactId: c.id, direction: "IN", text: "Как долго доступен курс?" } });
    expect(await handleIncomingDm(c, "Как долго доступен курс?", null, { aiAvailable: true })).toBe(true);
    expect(sendToContact).toHaveBeenCalledTimes(2);
    const [answer, menu] = sendToContact.mock.calls;
    expect(String(answer[1])).toMatch(/^Ассалому алейкум! Курс ҳамеша дар шумо мемонад/);
    expect(String(answer[1])).not.toMatch(/Кадом курс/); // выбор дают кнопки
    expect(String(menu[1])).toBe(MENU);
    expect((menu[2] as unknown[]).length).toBe(3);
    expect((await db.delivery.findFirstOrThrow({ where: { contactId: c.id } })).state).toBe("WAITING");
  });

  it.each([
    ["Включает ли стоимость kursa сертификат?", /Сертификат ба нархи курс дохил/],
    ["Можно ли купить отдельные рецепты?", /алоҳида фурӯхта намешаванд/],
    ["Как долго длится курс?", /бо вақти худатон/],
    ["Могу ли я с кем-нибудь пообщаться?", /ман Ширин/],
  ])("%s — свой ответ по-таджикски и меню", async (q, re) => {
    await dmFunnel();
    const c = await contact();
    expect(await handleIncomingDm(c, q, null, { aiAvailable: true })).toBe(true);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(re);
    expect(String(sendToContact.mock.calls[1][1])).toBe(MENU);
  });

  it("человек раньше писал по-русски своими словами — ответ по-русски", async () => {
    await dmFunnel();
    const c = await contact();
    await db.message.create({
      data: {
        contactId: c.id,
        direction: "IN",
        text: "Здравствуйте, хочу узнать про обучение",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await handleIncomingDm(c, "Как долго доступен курс?", null, { aiAvailable: true });
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/^Здравствуйте! Курс остаётся у вас навсегда/);
  });

  it("свой вариант вопроса из настройки instagramFaqExtra тоже узнаётся", async () => {
    await dmFunnel();
    await db.setting.create({ data: { key: "instagramFaqExtra", value: "certificate: Сертификат дадите?" } });
    const c = await contact();
    expect(await handleIncomingDm(c, "Сертификат дадите?", null, { aiAvailable: true })).toBe(true);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/Сертификат ба нархи курс дохил/);
  });

  it("экстренная пауза — только меню, ответ не шлём («всё, кроме воронки»)", async () => {
    await dmFunnel();
    await db.setting.create({ data: { key: "botFrozen", value: "true" } });
    const c = await contact();
    expect(await handleIncomingDm(c, "Как долго доступен курс?", null, { aiAvailable: false })).toBe(true);
    expect(sentTexts()).toEqual([MENU]);
  });
});

describe("(д) напоминание «завтра переведу»", () => {
  /** Номер ушёл за 21 ч, отсрочка — последнее сообщение человека `hoursAgo` назад. */
  async function deferred(hoursAgo: number, text = "пагоҳ пулро мефиристам", over: Partial<Contact> = {}) {
    const c = await contact(over);
    await db.message.create({
      data: {
        contactId: c.id,
        direction: "OUT",
        text: NUMBER_STEP,
        mid: `o-${c.id}`,
        createdAt: new Date(Date.now() - (hoursAgo + 0.5) * HOUR),
      },
    });
    await db.message.create({
      data: { contactId: c.id, direction: "IN", text, createdAt: new Date(Date.now() - hoursAgo * HOUR) },
    });
    return c;
  }

  it("ГЛАВНОЕ: через 20 ч — одно тёплое напоминание с номером; повторный тик второго не шлёт", async () => {
    const c = await deferred(20.5);
    expect(await runPaymentReminders()).toBe(1);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    const msg = String(sendToContact.mock.calls[0][1]);
    expect(msg).toMatch(PHONE);
    expect(msg).toContain("Фарангис Чаборова");
    expect(msg).not.toMatch(/[—–]/);
    expect(msg).toMatch(/шумо|бошед|фиристед/);
    expect((await db.paymentReminder.findFirstOrThrow({ where: { contactId: c.id } })).state).toBe("SENT");
    // Заготовка текста легла в настройки — дальше её правит владелец.
    expect((await db.setting.findUnique({ where: { key: "paymentReminderTextTg" } }))?.value).toBe(
      PAYMENT_REMINDER_SEED.tg,
    );
    sendToContact.mockClear();
    expect(await runPaymentReminders()).toBe(0);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("рано (19 ч) — ещё нет; окно Meta почти закрыто (23,5 ч) — уже нет", async () => {
    await deferred(19);
    await deferred(23.5);
    expect(await runPaymentReminders()).toBe(0);
  });

  it("по-русски «завтра переведу» — напоминание по-русски", async () => {
    await deferred(21, "Хорошо, завтра переведу");
    await runPaymentReminders();
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/^Здравствуйте! Напоминаю/);
  });

  it("не шлём: оплатил, прислал чек, писал после, Ширин говорила, «только чеки» в WhatsApp, отказ «не надо»", async () => {
    const paid = await deferred(21);
    await db.purchase.create({ data: { contactId: paid.id, course: "COURSE70", amount: 70 } });
    const receipt = await deferred(21);
    await db.receiptCheck.create({
      data: { contactId: receipt.id, imageHash: "h1", kind: "receipt", confidence: 50, reason: "сомнительный" },
    });
    const talked = await deferred(22);
    await db.message.create({
      data: {
        contactId: talked.id,
        direction: "IN",
        text: "а сертификат будет?",
        createdAt: new Date(Date.now() - 21 * HOUR),
      },
    });
    const shirin = await deferred(21);
    await db.message.create({
      data: {
        contactId: shirin.id,
        direction: "OUT",
        byHuman: true,
        text: "Хоп",
        mid: `h-${shirin.id}`,
        createdAt: new Date(Date.now() - 20.8 * HOUR),
      },
    });
    await db.setting.create({ data: { key: "whatsappReceiptsOnly", value: "true" } });
    await deferred(21, "пагоҳ мепартоям", { channel: "WHATSAPP" });
    await deferred(21, "не надо, спасибо");
    await deferred(21, "пагоҳ", { personal: true });
    expect(await runPaymentReminders()).toBe(0);
    expect(sendToContact).not.toHaveBeenCalled();
    // Каждая причина записана (след для разбора), «писал после» и «не надо» — вовсе не отсрочка.
    const reasons = (await db.paymentReminder.findMany()).map((r) => `${r.state}:${r.reason}`).sort();
    expect(reasons).toEqual(
      [
        "SKIPPED:contact_policy",
        "SKIPPED:paid",
        "SKIPPED:receipt",
        "SKIPPED:talked_with_shirin",
        "SKIPPED:whatsapp_receipts_only",
      ].sort(),
    );
  });

  it("номер этому человеку не уходил — «завтра» не про оплату, молчим", async () => {
    const c = await contact();
    await db.message.create({
      data: { contactId: c.id, direction: "IN", text: "завтра напишу", createdAt: new Date(Date.now() - 21 * HOUR) },
    });
    expect(await runPaymentReminders()).toBe(0);
  });

  it("рубильник выключен или бот на паузе — молчим", async () => {
    await deferred(21);
    await db.setting.create({ data: { key: "paymentReminderEnabled", value: "false" } });
    expect(await runPaymentReminders()).toBe(0);
    await db.setting.update({ where: { key: "paymentReminderEnabled" }, data: { value: "true" } });
    await db.setting.create({ data: { key: "botFrozen", value: "true" } });
    expect(await runPaymentReminders()).toBe(0);
  });

  it("владелец стёр текст — не шлём, а не подставляем заготовку", async () => {
    await deferred(21);
    await db.setting.create({ data: { key: "paymentReminderTextTg", value: "" } });
    expect(await runPaymentReminders()).toBe(0);
  });
});

describe("(е) сводка: «получили номер карты» и тревога при падении", () => {
  async function gotNumber(daysAgo: number, n: number) {
    for (let i = 0; i < n; i++) {
      const c = await contact({ createdAt: new Date(Date.now() - daysAgo * 24 * HOUR - 60_000) });
      await db.message.create({
        data: {
          contactId: c.id,
          direction: "OUT",
          text: `Рақами корт 905-355-355`,
          mid: `n-${c.id}`,
          createdAt: new Date(Date.now() - daysAgo * 24 * HOUR - 60_000),
        },
      });
    }
  }

  it("цифры за сутки, вчера и среднее за 7 дней; строка в сводке", async () => {
    await gotNumber(0, 2);
    await gotNumber(1, 10);
    for (let d = 2; d <= 7; d++) await gotNumber(d, 10);
    const r = await requisitesReach();
    expect(r).toMatchObject({ last24h: 2, prev24h: 10, avg7: 10 });
    expect(requisitesReachLine(r)).toBe("💳 номер карты получили: 2 за сутки (вчера 10 · в среднем 10)");
    expect(await buildReport(5 * HOUR, r)).toContain("💳 номер карты получили: 2 за сутки");
  });

  it("тревога владельцу: меньше половины среднего при 20+ новых; мало новых — нет", async () => {
    expect(requisitesDropped({ last24h: 2, prev24h: 10, avg7: 10, newContacts24h: 25 })).toBe(true);
    expect(requisitesDropped({ last24h: 2, prev24h: 10, avg7: 10, newContacts24h: 5 })).toBe(false);
    expect(requisitesDropped({ last24h: 6, prev24h: 10, avg7: 10, newContacts24h: 25 })).toBe(false);
    expect(await alertIfRequisitesDropped({ last24h: 2, prev24h: 10, avg7: 10, newContacts24h: 25 })).toBe(true);
    expect(notifyOwnerDirect).toHaveBeenCalledTimes(1);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("Номер карты получили 2");
    // Вид «Сбои» по умолчанию — только владельцу, с дедупликацией.
    expect(notifyOwnerDirect.mock.calls[0][1]).toMatchObject({ dedupeKey: "requisites-drop" });
  });
});

describe("(ж) ревью #99: номер не к месту", () => {
  it("уже купил «21 рецепт» и спрашивает про него — номер не клеим; про второй курс — клеим", async () => {
    const c = await contact();
    await db.purchase.create({ data: { contactId: c.id, course: "COURSE70", amount: 70 } });
    const own = await applyRequisitesOffer(c.id, "21 рецепт сколько стоит?", "Курс у вас уже есть.", "ru");
    expect(own.carriesRequisites).toBe(false);
    const other = await applyRequisitesOffer(c.id, "арт десерт сколько стоит?", "Арт десерт — отдельный курс.", "ru");
    expect(other.carriesRequisites).toBe(true);
    expect(other.text).toMatch(PHONE);
  });

  it("«нархаш чанд?» сразу после вопроса про офлайн — номер онлайн-курса не клеим", async () => {
    const c = await contact();
    await db.message.create({
      data: {
        contactId: c.id,
        direction: "IN",
        text: "офлайн курс кай сар мешавад?",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const r = await applyRequisitesOffer(c.id, "нархаш чанд?", "Офлайн курс 1500 сомонӣ.", "tg");
    expect(r.carriesRequisites).toBe(false);
    expect(r.text).not.toMatch(PHONE);
    // Явно вернулся к онлайну — номер снова к месту.
    const back = await applyRequisitesOffer(c.id, "онлайн курс нархаш чанд?", "", "tg");
    expect(back.carriesRequisites).toBe(true);
  });

  it("сводка: напоминание с номером на следующий день — не новый «получил номер»", async () => {
    const c = await contact();
    await db.message.create({
      data: {
        contactId: c.id,
        direction: "OUT",
        text: NUMBER_STEP,
        mid: `a-${c.id}`,
        createdAt: new Date(Date.now() - 30 * HOUR),
      },
    });
    await db.message.create({
      data: {
        contactId: c.id,
        direction: "OUT",
        text: NUMBER_STEP,
        mid: `b-${c.id}`,
        createdAt: new Date(Date.now() - 2 * HOUR),
      },
    });
    const r = await requisitesReach();
    expect(r.last24h).toBe(0);
    expect(r.prev24h).toBe(1);
  });
});
