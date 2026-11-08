import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
const sendTelegramMessage = vi.fn(async () => 1);

vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "INSTAGRAM",
}));
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import {
  maybeRestoreAccess,
  looksLikeAccessRequest,
  restoreAccessFromSite,
  relinkBySiteToken,
  resetRelinkMemory,
} from "../../src/course/recovery.js";
import type { Contact } from "@prisma/client";

const contact = fakeContact() as unknown as Contact;

function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { value: values[where.key] } : null;
}

const WEB_MODE = { courseDeliveryMode: "web", telegramBotToken: "token", telegramOwnerChatId: "owner" };

function activePurchase(over: Record<string, unknown> = {}) {
  return {
    id: "purchase-1",
    contactId: contact.id,
    revokedAt: null,
    linkReissueCount: 0,
    linkReissuedAt: null,
    ...over,
  };
}

describe("looksLikeAccessRequest", () => {
  it("ловит живые формулировки на обоих языках", () => {
    for (const text of [
      "не открывается курс",
      "ссылка не работает",
      "потеряла ссылку",
      "я сменила телефон, как войти",
      "пришлите новую ссылку пожалуйста",
      "линк кор намекунад",
      "дастрасӣ надорам",
      "пишет что уже открыт на 2 устройствах",
    ]) {
      expect(looksLikeAccessRequest(text), text).toBe(true);
    }
  });

  it("не срабатывает на обычных вопросах — иначе бот перебивал бы консультанта", () => {
    for (const text of ["сколько стоит курс", "здравствуйте", "а есть рассрочка", "где вы находитесь", "не открывается видео", "не работает миксер", "кор намекунад", "не могу посмотреть видео урока", "新", "потеряла рецепт"]) {
      expect(looksLikeAccessRequest(text), text).toBe(false);
    }
  });

  it("длинный текст не считается просьбой: это уже рассказ, его должен читать консультант", () => {
    expect(looksLikeAccessRequest("не открывается ".repeat(40))).toBe(false);
  });
});

describe("maybeRestoreAccess", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(fakeContact());
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    sendText.mockClear();
    sendTelegramMessage.mockClear();
    db.model("setting").findUnique.mockImplementation(settings(WEB_MODE));
  });
  afterEach(restorePrisma);

  it("покупок нет — не наш случай, отвечает консультант", async () => {
    db.model("purchase").findMany.mockResolvedValue([]);

    const result = await maybeRestoreAccess(contact, "не открывается ссылка");

    expect(result).toEqual({ handled: false });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: отозванный доступ бот сам НЕ возвращает — это решение владельца", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ revokedAt: new Date() })]);

    const result = await maybeRestoreAccess(contact, "не открывается курс, верните доступ");

    expect(result).toMatchObject({ handled: true, outcome: "revoked" });
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    // Человеку — вежливо, владельцу — тревога.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("ОТОЗВАН");
  });

  it("покупка есть, но следа оплаты в базе нет — к владельцу, а не автоматом", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("purchase").count.mockResolvedValue(0);

    const result = await maybeRestoreAccess(contact, "потеряла ссылку");

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("чека в базе нет");
  });

  it("подтверждённый чек есть — ссылка выдаётся сама и счётчик растёт", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    const result = await maybeRestoreAccess(contact, "не могу зайти, дайте ссылку заново");

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toMatch(/\/l\/[A-Za-z0-9]{10}/);
    const counted = db.model("purchase").update.mock.calls.find(
      (c) => (c[0] as { data: Record<string, unknown> }).data.linkReissueCount
    );
    expect(counted).toBeTruthy();
  });

  it("места на устройствах нет — самое давнее освобождается, чтобы новый телефон влез", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    // Лимит и занятость — ТЕ ЖЕ функции, что в access.ts (deviceLimitFor,
    // deviceCountFor), и считаются по ЧЕЛОВЕКУ: раньше recovery считал по-своему
    // и по покупке, и место не освобождал.
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ courseId: "course-1" })]);
    db.model("course").findMany.mockResolvedValue([{ id: "course-1", deviceLimit: 3 }]);
    db.model("device").count.mockResolvedValue(3);
    db.model("device").findFirst.mockResolvedValue({ id: "old", lastSeenAt: new Date("2026-01-01") });

    await maybeRestoreAccess(contact, "пишет что открыт на 2 устройствах");

    // Освобождаем ровно одно место, и именно самое старое из НЕзаблокированных.
    expect(db.model("device").delete).toHaveBeenCalledTimes(1);
    expect(db.model("device").delete).toHaveBeenCalledWith({ where: { id: "old" } });
    expect(db.model("device").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: contact.id, blockedAt: null } })
    );
  });

  it("ЗАБЛОКИРОВАННЫЕ СЧИТАЮТСЯ занятыми, но место за их счёт не освобождается", async () => {
    // Раньше recovery считал только незаблокированные: одно заблокировано +
    // одно живое = «места есть», ничего не удалял, а access видел 2 из 2 и не
    // пускал. Бот отвечал «вот новая ссылка», ученица упиралась в тот же отказ.
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ courseId: "course-1" })]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("course").findMany.mockResolvedValue([{ id: "course-1", deviceLimit: 2 }]);
    db.model("device").count.mockResolvedValue(2); // одно из них заблокировано
    db.model("device").findFirst.mockResolvedValue({ id: "live", lastSeenAt: new Date("2026-06-01") });

    await maybeRestoreAccess(contact, "не открывается на новом телефоне");

    expect(db.model("device").delete).toHaveBeenCalledWith({ where: { id: "live" } });
  });

  it("все места заняты заблокированными — автомат отступает, не удаляя ничего", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ courseId: "course-1" })]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("course").findMany.mockResolvedValue([{ id: "course-1", deviceLimit: 2 }]);
    db.model("device").count.mockResolvedValue(2);
    db.model("device").findFirst.mockResolvedValue(null);

    await maybeRestoreAccess(contact, "не открывается ссылка");

    expect(db.model("device").delete).not.toHaveBeenCalled();
  });

  it("ЗАЩИТА ОТ РАЗДАЧИ: четвёртая просьба за месяц уходит владельцу", async () => {
    db.model("purchase").findMany.mockResolvedValue([
      activePurchase({ linkReissueCount: 3, linkReissuedAt: new Date() }),
    ]);
    db.model("receiptCheck").count.mockResolvedValue(1);

    const result = await maybeRestoreAccess(contact, "потерял ссылку опять");

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(db.model("device").delete).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("4-й раз");
  });

  it("старые перевыдачи не считаются — счётчик смотрит только на последние 30 дней", async () => {
    db.model("purchase").findMany.mockResolvedValue([
      activePurchase({ linkReissueCount: 5, linkReissuedAt: new Date("2025-01-01") }),
    ]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    const result = await maybeRestoreAccess(contact, "не открывается ссылка");

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
  });

  it("выдача идёт через Telegram-группу — платформенную ссылку не шлём", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ courseDeliveryMode: "telegram", telegramBotToken: "token", telegramOwnerChatId: "owner" })
    );
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);

    const result = await maybeRestoreAccess(contact, "не открывается ссылка");

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(String(sendText.mock.calls[0][1])).not.toMatch(/\/l\/[A-Za-z0-9]{10}/);
  });

  it("ручная выдача владельцем считается доказательством оплаты — чека там и не бывает", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("purchase").count.mockResolvedValue(1); // source = MANUAL
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    const result = await maybeRestoreAccess(contact, "не могу открыть уроки");

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
  });

  it("failed send preserves valid link, devices and reissue budget; owner sees failure", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("contact").findUnique.mockResolvedValue({ accessTokenId: "Ab3kQ9xZpm", accessIssuedAt: new Date() });
    sendText.mockRejectedValueOnce(new Error("24h window closed"));
    expect(await maybeRestoreAccess(contact, "ссылка не открывается на новом телефоне")).toMatchObject({ outcome: "escalated" });
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(db.model("device").delete).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("НЕ доставлена");
  });

  it("lost link alone never releases a device", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    await maybeRestoreAccess(contact, "потеряла ссылку");
    expect(db.model("device").delete).not.toHaveBeenCalled();
    expect(db.model("device").count).not.toHaveBeenCalled();
  });

  it("владелец узнаёт о КАЖДОМ случае, даже когда бот справился сам", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    await maybeRestoreAccess(contact, "не открывается ссылка");

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("бот сам выдал");
  });

  it("готовые фразы экрана «напишите нам» сами запускают выдачу ссылки (RU и TG)", () => {
    // Те же слова, что в apps/web/src/course/i18n.ts linkAskText.
    expect(looksLikeAccessRequest("Нужна новая ссылка")).toBe(true);
    expect(looksLikeAccessRequest("Ссылкаи нав лозим")).toBe(true);
  });
});

/**
 * «ПОЛУЧИТЬ НОВУЮ ССЫЛКУ» НА САЙТЕ (аудит 08.11.2026): ссылка уходит в
 * переписку, на экран — только исход. Окно Instagram 24 часа соблюдаем.
 */
describe("restoreAccessFromSite", () => {
  let db: PrismaMock;
  const expiredContact = fakeContact({ accessTokenId: "Ab3kQ9xZpm", accessIssuedAt: new Date(Date.now() - 8 * 86_400_000) }) as unknown as Contact;

  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(expiredContact);
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    db.model("setting").findUnique.mockImplementation(settings(WEB_MODE));
    sendText.mockClear();
    sendTelegramMessage.mockClear();
  });
  afterEach(restorePrisma);

  it("ГЛАВНОЕ: человек писал сегодня — новая ссылка уходит в директ сама, без хозяйки", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 3_600_000), text: "салом" });

    expect(await restoreAccessFromSite(expiredContact)).toBe("sent");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toMatch(/\/l\/[A-Za-z0-9]{10}/);
    // Новая ссылка — новый код (старый просрочен), счётчик перевыдач растёт.
    expect(db.model("contact").updateMany).toHaveBeenCalled();
    expect(db.model("purchase").update).toHaveBeenCalled();
    expect(db.model("device").delete).not.toHaveBeenCalled();
  });

  it("окно Instagram закрыто (писала неделю назад) — просим написать первой, ничего не выдаём", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 7 * 86_400_000), text: "салом" });

    expect(await restoreAccessFromSite(expiredContact)).toBe("write_first");

    expect(sendText).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
  });

  it("чека нет — к хозяйке, и в переписку НИЧЕГО не пишем (повторные нажатия не спамят)", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("purchase").count.mockResolvedValue(0);

    expect(await restoreAccessFromSite(expiredContact)).toBe("escalated");

    expect(sendText).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("кнопка на сайте");
  });

  it("доступ отозван — честно «закрыт», ссылку не выдаём", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ revokedAt: new Date() })]);

    expect(await restoreAccessFromSite(expiredContact)).toBe("revoked");

    expect(sendText).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("контакт заведён вручную (нет канала для бота) — к хозяйке, код не трогаем", async () => {
    const manual = { ...expiredContact, channel: "MANUAL" } as Contact;
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);

    expect(await restoreAccessFromSite(manual)).toBe("escalated");

    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["чат ведёт человек", { humanTakenOverAt: new Date() }],
    ["бот приглушён на время", { humanSilencedUntil: new Date(Date.now() + 3_600_000) }],
    ["личный контакт", { personal: true }],
    ["сохранённый контакт WhatsApp", { whatsappSavedContact: true }],
  ])("%s — сразу «передали Ширин»: ссылку НЕ выдаём и старую не гасим", async (_name, policy) => {
    const blocked = { ...expiredContact, ...policy } as Contact;
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(), text: "салом" });

    expect(await restoreAccessFromSite(blocked)).toBe("escalated");

    expect(sendText).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("переписку ведёте вы");
  });

  it("купила через чат сайта — НЕ «ссылка уже у вас», а хозяйке; тревога каждый раз, без суточного глушения", async () => {
    const web = { ...expiredContact, channel: "WEB", name: "Мадина" } as Contact;
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(), text: "салом" });

    expect(await restoreAccessFromSite(web)).toBe("escalated");
    expect(await restoreAccessFromSite(web)).toBe("escalated");

    // Ничего не пишем в чат сайта и код не трогаем: старая ссылка не гаснет.
    expect(db.model("message").create).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("купила на сайте");
  });
});

/**
 * ИДЕМПОТЕНТНОСТЬ КНОПКИ (ревью PR 59): двойное нажатие — одна выдача, одно
 * сообщение, один шаг счётчика перевыдач.
 */
describe("relinkBySiteToken", () => {
  let db: PrismaMock;
  const code = "Ab3kQ9xZpm";
  const expiredContact = fakeContact({ accessTokenId: code, accessIssuedAt: new Date(Date.now() - 8 * 86_400_000) });

  beforeEach(() => {
    resetRelinkMemory();
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(expiredContact);
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    db.model("setting").findUnique.mockImplementation(settings(WEB_MODE));
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(), text: "салом" });
    sendText.mockClear();
    sendTelegramMessage.mockClear();
  });
  afterEach(restorePrisma);

  it("два нажатия разом и третье через минуту — одна ссылка в директ, счётчик +1", async () => {
    const [a, b] = await Promise.all([relinkBySiteToken(code), relinkBySiteToken(code)]);
    const c = await relinkBySiteToken(code, Date.now() + 60_000);

    expect([a.outcome, b.outcome, c.outcome]).toEqual(["sent", "sent", "sent"]);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(db.model("purchase").update).toHaveBeenCalledTimes(1);
  });

  it("через 10 минут память стирается — код уже заменён, исход «unknown», ничего не шлём", async () => {
    await relinkBySiteToken(code);
    db.model("contact").findUnique.mockResolvedValue(null); // после выдачи старый код никого не находит
    const later = await relinkBySiteToken(code, Date.now() + 11 * 60_000);

    expect(later).toEqual({ outcome: "unknown", channel: null });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("сбой базы не запоминается — следующее нажатие пробует снова", async () => {
    db.model("contact").findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(relinkBySiteToken(code)).rejects.toThrow("db down");
    expect((await relinkBySiteToken(code)).outcome).toBe("sent");
  });
});
