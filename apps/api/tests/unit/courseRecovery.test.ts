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

  it("«сменила телефон»: ссылка выдаётся, а ВСЕ старые устройства аннулируются, перенос тратится", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ courseId: "course-1" })]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);

    const result = await maybeRestoreAccess(contact, "я сменила телефон, дайте ссылку");

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
    expect(db.model("device").deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old-1", "old-2"] } } });
    const upd = db.model("contact").update.mock.calls[0][0] as { data: { deviceSwaps: number } };
    expect(upd.data.deviceSwaps).toBe(1);
  });

  it("ГЛАВНОЕ: второй перенос в этом месяце бот не делает — ссылки нет, владельцу сводка", async () => {
    const twice = { ...contact, deviceSwaps: 1, deviceSwapAt: new Date("2026-11-01") } as unknown as Contact;
    db.model("purchase").findMany.mockResolvedValue([activePurchase({ courseId: "course-1" })]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([
      { id: "d1", userAgent: "Android", lastCity: "TJ", lastSeenAt: new Date("2026-11-07"), blockedAt: null },
    ]);

    const result = await maybeRestoreAccess(twice, "сменила телефон, пишет что открыт на 2 устройствах");

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("один раз в месяц");
    const alert = String(sendTelegramMessage.mock.calls[0][2]);
    expect(alert).toContain("ВТОРОЙ раз");
    expect(alert).toContain("2026-11-01");
    expect(alert).toContain("Android");
  });

  it("обычная просьба о ссылке устройства не трогает", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    const result = await maybeRestoreAccess(contact, "потеряла ссылку");

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
  });

  it("переносить нечего (ни одного устройства) — перенос не тратится", async () => {
    db.model("purchase").findMany.mockResolvedValue([activePurchase()]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);

    await maybeRestoreAccess(contact, "сменила телефон");

    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(db.model("contact").update).not.toHaveBeenCalled();
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
});
