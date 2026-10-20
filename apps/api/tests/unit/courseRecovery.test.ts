import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
const sendTelegramMessage = vi.fn(async () => 1);

vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "INSTAGRAM",
}));
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { maybeRestoreAccess, looksLikeAccessRequest } from "../../src/course/recovery.js";
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
    for (const text of ["сколько стоит курс", "здравствуйте", "а есть рассрочка", "где вы находитесь"]) {
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

    await maybeRestoreAccess(contact, "не открывается");

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

    const result = await maybeRestoreAccess(contact, "не открывается");

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

  it("владелец узнаёт о КАЖДОМ случае, даже когда бот справился сам", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    await maybeRestoreAccess(contact, "не открывается");

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("бот сам выдал");
  });
});
