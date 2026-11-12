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

import { chatsForKind, chatRole, mutedKinds, sendReceiptForReview, setKindEnabled, setShirinEnabled, ownerChatIds, shirinChatIds } from "../../src/telegram.js";
import { sendKind } from "../../src/notify.js";
import { alertLabelFor, isExpectedFailure, notifyFunnelGaveUp, notifyOwnerOfSystemError, systemErrorMayAlert } from "../../src/systemAlerts.js";
import { runPaymentNotifications } from "../../src/paymentNotify.js";
import { NOTIFY_KINDS, MUTABLE_KINDS, NOTIFY_INFO, kindFromMessageText } from "../../src/notifyKinds.js";

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

  it("«Новая проблема» только для списка серьёзных источников: funnel:step — только в журнал", () => {
    expect(systemErrorMayAlert("funnel:step", "что угодно")).toBe(false);
    expect(systemErrorMayAlert("ai:reply", "Gemini упал")).toBe(true);
    expect(systemErrorMayAlert("ai:reply", "Contact messaging blocked: contact policy")).toBe(false);
  });

  it("КЛАСС: настоящие источники из logError(...) (ai:reply, ai:aiReply:noGeminiKeys, webhook:accept, telegram:webhook…) будят владельца по ПРЕФИКСУ", () => {
    for (const s of [
      "ai:reply",
      "ai:send",
      "ai:aiReply:noGeminiKeys",
      "ai:aiReplyToComment:noGeminiKeys",
      "ai:receiptVerdict:preTransfer",
      "webhook:accept",
      "webhook:signature",
      "telegram:webhook",
      "aiReplyRetry:queue",
      "receiptRetry:apply",
      "unhandledRejection",
    ]) {
      expect(systemErrorMayAlert(s, "ключи кончились"), s).toBe(true);
    }
    // мелочь и чужие имена с похожим началом — только в журнал
    for (const s of ["ai", "aix:reply", "airplane", "webhook:spamBlock", "webhook:learn", "ai:videoLibrary", "telegram:downloadFile", "stuckAlert:check"]) {
      expect(systemErrorMayAlert(s, "что угодно"), s).toBe(false);
    }
    expect(alertLabelFor("ai:aiReply:noGeminiKeys")).toBe("ИИ-ответ (ключи или модель)");
  });

  it("«ИИ лёг / кончились ключи» (ai:aiReply:noGeminiKeys) через notifyOwnerOfSystemError доходит до владельца спустя 30 минут", async () => {
    const t0 = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now");
    for (const dt of [0, 31]) {
      spy.mockReturnValue(t0 + dt * 60_000);
      await notifyOwnerOfSystemError("ai:aiReply:noGeminiKeys", "нет рабочих ключей Gemini");
    }
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock.mock.calls[0]?.[1]).toBe(DALER);
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

  it("карточка чека НЕ прячется, даже если единственное сомнение — «Ширин уже отправила ссылку вне системы» (может быть поддельный чек)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const caption = "Чек требует проверки\nОт: @x\nСумма: 70 сомони\nЧто смущает: похоже, Ширин уже отправила ссылку вне системы - проверьте и нажмите нужную кнопку";
      const sent = await sendReceiptForReview("tok", DALER, { imageUrl: "https://example.test/r.jpg", caption, receiptId: "r1" });
      expect(sent).toEqual({ chatId: DALER, messageId: 5 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("КЛАСС: решение кнопкой («Нужно ваше решение») не выключается ни кнопкой, ни словами, ни «выключить всё», ни панелью", async () => {
    expect(NOTIFY_INFO.decision.locked).toBe(true);
    expect(MUTABLE_KINDS).not.toContain("decision");
    // «выключено всё» по каждому изменяемому виду у владельца
    for (const k of MUTABLE_KINDS) await setKindEnabled("owner", k, false);
    await setKindEnabled("owner", "decision", false); // даже прямая попытка
    expect([...(await mutedKinds("owner"))]).not.toContain("decision");
    expect(await chatsForKind("decision")).toEqual([DALER]);
    // даже если в сохранённой настройке мусор/старая запись с этим видом
    settings["notifyOff:owner"] = JSON.stringify(["decision", "review", "security"]);
    expect(await chatsForKind("decision")).toEqual([DALER]);
    expect(await chatsForKind("security")).toEqual([]);
    // Ширин карточку-решение не получает никогда
    expect(await chatsForKind("decision")).not.toContain(SHIRIN);
  });

  it("sendKind: под карточкой-решением нет «🔕 Не присылать такое», свои кнопки остаются; у обычного вида — обе", async () => {
    await sendKind("decision", "карточка", { buttons: [[{ text: "Разрешить перенос", callback_data: "mn:tr:c1" }]] });
    const markup = JSON.stringify(sendTelegramMessageMock.mock.calls[0]?.[4]);
    expect(markup).toContain("mn:tr:c1");
    expect(markup).not.toContain("nf:off:");
    sendTelegramMessageMock.mockClear();
    await sendKind("human", "🙋 просит", { buttons: [[{ text: "Быстрый ответ", callback_data: "qr:c1:0" }]] });
    const m2 = JSON.stringify(sendTelegramMessageMock.mock.calls[0]?.[4]);
    expect(m2).toContain("qr:c1:0");
    expect(m2).toContain("nf:off:human");
  });

  it("карточку чека с кнопками (текст «Чек требует проверки») узнаём как невыключаемую; текст про дубль скриншота — обычный вид", () => {
    expect(kindFromMessageText("Чек требует проверки\nОт: @x")).toBe("decision");
    expect(kindFromMessageText("Чек требует проверки: этот же скриншот уже присылал другой человек")).toBe("review");
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

  it("сбой отправки оплаты пишется в ЖУРНАЛ ошибок (notify:payment), а не только в консоль", async () => {
    db.model("errorLog").findFirst.mockResolvedValue(null);
    db.model("errorLog").create.mockResolvedValue({});
    const now = new Date("2026-11-11T10:00:00Z");
    await runPaymentNotifications(now);
    db.model("purchase").findMany.mockResolvedValue([purchase("p1", "c1", "COURSE70", 70, new Date(now.getTime() + 1000))]);
    sendTelegramMessageMock.mockRejectedValue(new Error("Telegram API: Bad Request"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runPaymentNotifications(new Date(now.getTime() + 60_000));
      await vi.waitFor(() =>
        expect(db.model("errorLog").create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ source: "notify:payment" }) }),
        ),
      );
    } finally {
      sendTelegramMessageMock.mockReset();
      sendTelegramMessageMock.mockResolvedValue(1);
    }
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
