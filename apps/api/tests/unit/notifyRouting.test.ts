import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * Уведомления в Telegram (11.11.2026): кому что идёт, как выключается, и что
 * «шума» больше нет. Владелец (Далер) получает всё; Ширин — только главное
 * (оплата, запись на офлайн, итог дня).
 */
const sendTelegramMessageMock = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/telegram.js")>("../../src/telegram.js");
  return { ...actual, sendTelegramMessage: (...a: unknown[]) => sendTelegramMessageMock(...a) };
});

import { chatsForKind, chatRole, setKindEnabled, setShirinEnabled, isResolvedReviewCard, ownerChatIds, shirinChatIds } from "../../src/telegram.js";
import { sendKind } from "../../src/notify.js";
import { isExpectedFailure, notifyFunnelGaveUp, notifyOwnerOfSystemError, systemErrorMayAlert } from "../../src/systemAlerts.js";
import { runPaymentNotifications } from "../../src/paymentNotify.js";
import { NOTIFY_KINDS, NOTIFY_INFO, kindFromMessageText } from "../../src/notifyKinds.js";

const SHIRIN = "7916128767";
const DALER = "893446307";

let db: PrismaMock;
let settings: Record<string, string>;

beforeEach(() => {
  db = mockPrisma();
  // Как на проде: telegramOwnerChatId = чат Ширин (= её Telegram-id), технический чат = Далер.
  settings = {
    telegramBotToken: "tok",
    telegramOwnerChatId: SHIRIN,
    telegramQaOwnerId: SHIRIN,
    telegramTechChatId: DALER,
    telegramReportChatId: DALER,
    telegramSummaryChatIds: `${DALER},${SHIRIN}`,
  };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("setting").upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    settings[where.key] = update.value;
    return { key: where.key, value: update.value };
  });
  sendTelegramMessageMock.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("роли", () => {
  it("владелец и Ширин различаются; Ширин не попадает в список владельца", async () => {
    expect(await ownerChatIds()).toEqual([DALER]);
    expect(await shirinChatIds()).toEqual([SHIRIN]);
    expect(await chatRole(DALER)).toBe("owner");
    expect(await chatRole(SHIRIN)).toBe("shirin");
    expect(await chatRole("555")).toBeNull();
  });

  it("если Telegram-id Ширин по ошибке стоит в техническом чате — вычёркивается", async () => {
    settings.telegramTechChatId = `${DALER},${SHIRIN}`;
    expect(await ownerChatIds()).toEqual([DALER]);
  });
});

describe("КЛАСС: кому идёт каждый вид", () => {
  it("«главное» (оплата, офлайн, итог дня) — владельцу и Ширин", async () => {
    for (const kind of ["payment", "offline", "day"] as const) {
      expect((await chatsForKind(kind)).sort()).toEqual([DALER, SHIRIN].sort());
    }
  });

  it("всё служебное — ТОЛЬКО владельцу, ни один такой вид не доходит до Ширин", async () => {
    for (const kind of NOTIFY_KINDS.filter((k) => NOTIFY_INFO[k].audience === "owner")) {
      expect(await chatsForKind(kind)).toEqual([DALER]);
    }
  });

  it("Ширин можно выключить целиком — владелец продолжает получать всё", async () => {
    await setShirinEnabled(false);
    expect(await chatsForKind("payment")).toEqual([DALER]);
  });

  it("выключенный вид не уходит тому, кто его выключил, остальным идёт", async () => {
    await setKindEnabled("owner", "payment", false);
    expect(await chatsForKind("payment")).toEqual([SHIRIN]);
    await setKindEnabled("owner", "payment", true);
    await setKindEnabled("shirin", "day", false);
    expect(await chatsForKind("day")).toEqual([DALER]);
  });

  it("владельца нет в настройках — служебное не уходит никому (Ширин не подменяет)", async () => {
    delete settings.telegramTechChatId;
    delete settings.telegramReportChatId;
    expect(await chatsForKind("failure")).toEqual([]);
  });

  it("sendKind: сообщение с кнопкой «Не присылать такое», служебное не уходит Ширин", async () => {
    await sendKind("failure", "сбой");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    const call = sendTelegramMessageMock.mock.calls[0];
    expect(call?.[1]).toBe(DALER);
    expect(JSON.stringify(call?.[4])).toContain("nf:off:failure");
  });

  it("sendKind: повтор по тому же ключу в пределах 6 часов молчит", async () => {
    await sendKind("failure", "a", { dedupeKey: "k" });
    await sendKind("failure", "a", { dedupeKey: "k" });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("по первому значку сообщения узнаём вид (ответ «не присылай такое» реплаем)", () => {
    expect(kindFromMessageText("💰 Оплата: @x")).toBe("payment");
    expect(kindFromMessageText("🌙 11 ноября")).toBe("day");
    expect(kindFromMessageText("🙋 @x просит")).toBe("human");
    expect(kindFromMessageText("привет")).toBeNull();
  });
});

describe("КЛАСС: шума больше нет", () => {
  it("«ожидаемые» отказы (contact policy, окно Instagram) не поднимают тревогу", async () => {
    expect(isExpectedFailure("Contact messaging blocked: contact policy")).toBe(true);
    expect(isExpectedFailure("Meta delivery WINDOW (HTTP 400, code 10, subcode 2018278)")).toBe(true);
    expect(isExpectedFailure("Meta delivery TOKEN (HTTP 401)")).toBe(false);
    await notifyFunnelGaveUp("@x", 11, "Contact messaging blocked: contact policy");
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("настоящая причина (Meta отклоняет) — одно сообщение владельцу на причину", async () => {
    await notifyFunnelGaveUp("@a", 11, "Meta delivery TOKEN (HTTP 401)");
    await notifyFunnelGaveUp("@b", 11, "Meta delivery TOKEN (HTTP 401)");
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]?.[1]).toBe(DALER);
  });

  it("«Новая проблема» только для списка серьёзных источников: funnel:step и telegram:webhook — только в журнал", () => {
    expect(systemErrorMayAlert("funnel:step", "что угодно")).toBe(false);
    expect(systemErrorMayAlert("telegram:webhook", "отклонён: неверный секрет заголовка")).toBe(false);
    expect(systemErrorMayAlert("ai", "Gemini упал")).toBe(true);
    expect(systemErrorMayAlert("ai", "Contact messaging blocked: contact policy")).toBe(false);
  });

  it("notifyOwnerOfSystemError по funnel:step молчит даже спустя часы", async () => {
    const t0 = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now");
    for (const dt of [0, 31, 62, 200]) {
      spy.mockReturnValue(t0 + dt * 60_000);
      await notifyOwnerOfSystemError("funnel:step", "Contact messaging blocked: contact policy");
    }
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("карточка чека, где единственное сомнение — «Ширин уже отправила ссылку вне системы», не приходит", () => {
    const base = "Чек требует проверки\nОт: @x\nСумма: 70 сомони\n";
    expect(isResolvedReviewCard(`${base}Что смущает: похоже, Ширин уже отправила ссылку вне системы - проверьте и нажмите нужную кнопку`)).toBe(true);
    expect(isResolvedReviewCard(`${base}Что смущает: сумма не совпадает; похоже, Ширин уже отправила ссылку вне системы - проверьте`)).toBe(false);
    expect(isResolvedReviewCard(`${base}Что смущает: дата старая`)).toBe(false);
  });

  it("в коде нет текстов удалённых уведомлений и нет прямых обходов маршрутизации", () => {
    const root = path.resolve(__dirname, "../../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const banned = ["Ждут ответа в директе", "Комментарии без ответа:", "Напоминание — ждут вас", "не зашёл(шла) в группу", "📵 ${textFor"];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const b of banned) expect(src.includes(b), `${path.basename(f)} содержит «${b}»`).toBe(false);
    }
    // Служебные письма — только через sendKind/chatsForKind: прямой techChatIds остался лишь у ai.ts (вид «human»).
    for (const f of files) {
      const name = path.basename(f);
      if (name === "telegram.ts" || name === "ai.ts") continue;
      expect(/techChatIds\(/.test(fs.readFileSync(f, "utf8")), `${name} зовёт techChatIds()`).toBe(false);
    }
  });
});

describe("«Пришла оплата»", () => {
  function purchase(id: string, contactId: string, course: string, amount: number, at: Date) {
    return { id, contactId, course, amount, source: "RECEIPT", createdAt: at, contact: { username: `u${contactId}`, igUserId: "ig-1234567" } };
  }

  it("первый запуск ставит отметку и молчит; новая покупка — одно сообщение и больше не повторяется", async () => {
    const now = new Date("2026-11-11T10:00:00Z");
    expect(await runPaymentNotifications(now)).toBe(0);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    const row = purchase("p1", "c1", "COURSE70", 70, new Date(now.getTime() + 30_000));
    db.model("purchase").findMany.mockResolvedValue([row]);
    await runPaymentNotifications(new Date(now.getTime() + 60_000));
    // владельцу и Ширин
    expect(sendTelegramMessageMock.mock.calls.map((c) => c[1]).sort()).toEqual([DALER, SHIRIN].sort());
    expect(String(sendTelegramMessageMock.mock.calls[0]?.[2])).toContain("70 сомони");
    sendTelegramMessageMock.mockClear();
    await runPaymentNotifications(new Date(now.getTime() + 120_000));
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("комплект из двух курсов — одно сообщение на человека", async () => {
    const now = new Date("2026-11-11T10:00:00Z");
    await runPaymentNotifications(now);
    const at = new Date(now.getTime() + 30_000);
    db.model("purchase").findMany.mockResolvedValue([purchase("p1", "c1", "COURSE70", 70, at), purchase("p2", "c1", "COURSE50", 30, at)]);
    await runPaymentNotifications(new Date(now.getTime() + 60_000));
    expect(sendTelegramMessageMock.mock.calls.filter((c) => c[1] === DALER)).toHaveLength(1);
    expect(String(sendTelegramMessageMock.mock.calls[0]?.[2])).toContain("100 сомони");
  });

  it("Ширин выключила оплаты — ей не идёт, владельцу идёт", async () => {
    await setKindEnabled("shirin", "payment", false);
    const now = new Date("2026-11-11T10:00:00Z");
    await runPaymentNotifications(now);
    db.model("purchase").findMany.mockResolvedValue([purchase("p1", "c1", "COURSE70", 70, new Date(now.getTime() + 1000))]);
    await runPaymentNotifications(new Date(now.getTime() + 60_000));
    expect(sendTelegramMessageMock.mock.calls.map((c) => c[1])).toEqual([DALER]);
  });
});
