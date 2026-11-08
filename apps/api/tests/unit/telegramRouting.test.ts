import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * Маршруты получателей Telegram (08.11.2026): сестра получает ТОЛЬКО вечернюю
 * сводку и карточки подозрительных чеков; всё техническое — только владельцу.
 * Плюс шлюз: один и тот же алерт не чаще раза в 6 часов, сбой — только если
 * длится дольше 30 минут.
 */

const sendTelegramMessageMock = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/telegram.js")>("../../src/telegram.js");
  return { ...actual, sendTelegramMessage: (...a: unknown[]) => sendTelegramMessageMock(...a) };
});

import { techChatIds, summaryChatIds, trustedChatIds } from "../../src/telegram.js";
import { shouldSendAlert, ALERT_SUSTAINED_MS, ALERT_COOLDOWN_MS } from "../../src/alertGate.js";
import { notifyOwnerDirect, notifyOwnerOfSystemError, notifyFunnelGaveUp } from "../../src/systemAlerts.js";

const SISTER = "7916128767";
const OWNER = "893446307";

let db: PrismaMock;
let settings: Record<string, string>;

beforeEach(() => {
  db = mockPrisma();
  settings = { telegramBotToken: "tok", telegramOwnerChatId: SISTER, telegramReportChatId: OWNER };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null
  );
  db.model("setting").upsert.mockImplementation(
    async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      settings[where.key] = update.value;
      return { key: where.key, value: update.value };
    }
  );
  sendTelegramMessageMock.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("получатели", () => {
  it("техника: по умолчанию только владелец (чат сводок), сестра — никогда", async () => {
    expect(await techChatIds()).toEqual([OWNER]);
  });

  it("техника: явная настройка telegramTechChatId главнее", async () => {
    settings.telegramTechChatId = "111, 222";
    expect(await techChatIds()).toEqual(["111", "222"]);
  });

  it("техника: нет ни настройки, ни чата сводок — никому", async () => {
    delete settings.telegramReportChatId;
    expect(await techChatIds()).toEqual([]);
  });

  it("сводка и чеки: по умолчанию владелец и сестра без дублей", async () => {
    expect((await summaryChatIds()).sort()).toEqual([OWNER, SISTER].sort());
    settings.telegramReportChatId = SISTER;
    expect(await summaryChatIds()).toEqual([SISTER]);
  });

  it("сводка и чеки: явная telegramSummaryChatIds главнее", async () => {
    settings.telegramSummaryChatIds = `${OWNER},${SISTER}`;
    expect(await summaryChatIds()).toEqual([OWNER, SISTER]);
  });

  it("telegramAdminIds (вход в панель) не влияет на получателей", async () => {
    settings.telegramAdminIds = "999";
    expect(await techChatIds()).toEqual([OWNER]);
    expect(await summaryChatIds()).not.toContain("999");
  });

  it("доверенные для кнопок: и владелец, и сестра", async () => {
    settings.telegramTechChatId = OWNER;
    const trusted = await trustedChatIds();
    expect(trusted).toContain(OWNER);
    expect(trusted).toContain(SISTER);
  });
});

describe("технические уведомления идут только владельцу", () => {
  it("notifyOwnerDirect: сестра ничего не получает", async () => {
    await notifyOwnerDirect("тест");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]?.[1]).toBe(OWNER);
  });

  it("notifyOwnerDirect с ключом: повтор в пределах 6 часов молчит", async () => {
    await notifyOwnerDirect("a", { dedupeKey: "k1" });
    await notifyOwnerDirect("a", { dedupeKey: "k1" });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    await notifyOwnerDirect("b", { dedupeKey: "k2" });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
  });

  it("notifyFunnelGaveUp: одна и та же причина — одно сообщение, и только владельцу", async () => {
    await notifyFunnelGaveUp("@a", 11, "INSTAGRAM 400 invalid token");
    await notifyFunnelGaveUp("@b", 11, "INSTAGRAM 400 invalid token");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]?.[1]).toBe(OWNER);
  });

  it("notifyOwnerOfSystemError: короткий сбой молчит, длительный (>30 мин) будит владельца один раз", async () => {
    const t0 = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(t0);
    await notifyOwnerOfSystemError("whatsapp:connection", "ECONNREFUSED");
    spy.mockReturnValue(t0 + 10 * 60_000);
    await notifyOwnerOfSystemError("whatsapp:connection", "ECONNREFUSED");
    expect(sendTelegramMessageMock).not.toHaveBeenCalled(); // мост перезапустился — тишина

    spy.mockReturnValue(t0 + 20 * 60_000);
    await notifyOwnerOfSystemError("whatsapp:connection", "ECONNREFUSED");
    spy.mockReturnValue(t0 + 31 * 60_000);
    await notifyOwnerOfSystemError("whatsapp:connection", "ECONNREFUSED");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]?.[1]).toBe(OWNER);

    spy.mockReturnValue(t0 + 41 * 60_000);
    await notifyOwnerOfSystemError("whatsapp:connection", "ECONNREFUSED");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1); // дедуп 6 часов
  });
});

describe("шлюз алертов", () => {
  it("без порога: первый раз пропускает, повтор в 6 часов — нет, после 6 часов — да", async () => {
    const t0 = 1_800_000_000_000;
    expect(await shouldSendAlert("x", { now: t0 })).toBe(true);
    expect(await shouldSendAlert("x", { now: t0 + 60_000 })).toBe(false);
    expect(await shouldSendAlert("x", { now: t0 + ALERT_COOLDOWN_MS + 1 })).toBe(true);
  });

  it("порог 30 минут: короткий сбой не считается, пауза >45 мин сбрасывает отсчёт", async () => {
    const t0 = 1_800_000_000_000;
    const min = 60_000;
    const o = { sustainedMs: ALERT_SUSTAINED_MS };
    expect(await shouldSendAlert("y", { ...o, now: t0 })).toBe(false);
    expect(await shouldSendAlert("y", { ...o, now: t0 + 20 * min })).toBe(false);
    // сбой «кончился» (пауза 60 мин) и начался заново
    expect(await shouldSendAlert("y", { ...o, now: t0 + 80 * min })).toBe(false);
    expect(await shouldSendAlert("y", { ...o, now: t0 + 100 * min })).toBe(false);
    expect(await shouldSendAlert("y", { ...o, now: t0 + 111 * min })).toBe(true);
  });
});
