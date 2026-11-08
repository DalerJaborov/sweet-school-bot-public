import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Третий проход ревью PR 60 + корпус сценариев умного перехвата.
 * Покрывает: обращения к самой Ширин (не родня), ответы на истории, намеренное молчание в очереди,
 * запас сторожа к концу паузы, один запрос профиля на контакт.
 */
const reply = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../src/ai.js", () => ({ aiReply: (...args: unknown[]) => reply(...args) }));
const send = vi.fn(async (..._a: unknown[]) => "notice-mid");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => send(...a) }));
const notifyOwnerDirect = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../src/systemAlerts.js", () => ({ notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a) }));
vi.mock("../../src/alertGate.js", () => ({ shouldSendAlert: vi.fn(async () => true) }));
vi.mock("../../src/ai/takeoverHeal.js", () => ({ healFalseTakeovers: vi.fn(async () => 0) }));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key"]) }));

import { startsWithFamilyAddress } from "../../src/ai/personalContact.js";
import { storyReplyWorthAnswer, isStoryChatter } from "../../src/ai/storyRelevance.js";
import { retryPendingAiReplies } from "../../src/aiReplyRetry.js";
import { noteDeliberateSilence, resetDeliberateSilence } from "../../src/ai/deliberateSilence.js";
import { checkUnansweredInbound } from "../../src/inboundWatch.js";
import { markListedPersonalNow } from "../../src/profiles.js";
import { decideTakeover, isSafeIntent, TAKEOVER_DEFAULTS } from "../../src/ai/ownerTakeover.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { aiEnabled: "true", timezoneOffsetHours: "5" };
beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("message").findFirst.mockResolvedValue(null);
  reply.mockClear();
  send.mockClear();
  notifyOwnerDirect.mockClear();
  resetDeliberateSilence();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("пункт 2: так обращаются к самой Ширин, это не родня", () => {
  it.each(["Хоҳарҷон, салом, нарх чанд?", "Хохарчон салом", "Модарҷон, салом", "Модарчон, курс кай?", "Тётя, сколько стоит?", "Тетя, добрый день"])(
    "%s: клиентка",
    (t) => expect(startsWithFamilyAddress(t)).toBe(false),
  );
  it.each(["Мама, ты дома?", "Доченька, как ты?", "Сынок, позвони", "Бабушка, привет"])("%s: родня", (t) =>
    expect(startsWithFamilyAddress(t)).toBe(true),
  );
});

describe("пункт 3: ответы на истории — корпус", () => {
  it.each(["❤️", "🔥🔥🔥", "красиво!", "Круто", "супер 😍", "Рахмат", "Зебо", "so beautiful", "Вау, шикарно"])(
    "молчим на «%s»",
    (t) => expect(storyReplyWorthAnswer({ replyText: t })).toBe(false),
  );
  it.each(["Подробнее", "Хочу научиться", "Где вы находитесь?", "Можно информацию?", "Маълумот диҳед", "Цена?", "сколько стоит курс"])(
    "отдаём модели «%s»",
    (t) => expect(storyReplyWorthAnswer({ replyText: t })).toBe(true),
  );
  it("голосовое и вложения не теряем", () => {
    expect(storyReplyWorthAnswer({ replyText: null, hasMedia: true })).toBe(true);
    expect(isStoryChatter(null)).toBe(true);
  });
});

function pendingRow(text = "Сколько стоит курс?") {
  return {
    id: "p1",
    contactId: "contact-1",
    text,
    snapshotAt: new Date(Date.now() - 3 * 60_000),
    attempts: 1,
    delayNoticeAt: null,
    contact: fakeContact(),
  };
}

describe("пункт 4: намеренное молчание в очереди — успех, не провал", () => {
  it("NO_REPLY / реакция: строка закрыта, без «не получается подготовить ответ»", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    reply.mockImplementationOnce(async () => noteDeliberateSilence("contact-1", "модель вернула явную метку NO_REPLY"));
    await retryPendingAiReplies();
    expect(db.model("pendingAiReply").delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(send).not.toHaveBeenCalled();
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
  });
  it("фильтр «не по делу» (запись в журнале шлюза) — тоже успех", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("replyGate").findFirst.mockResolvedValue({ id: "g1", action: "silent" });
    await retryPendingAiReplies();
    expect(db.model("pendingAiReply").delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(send).not.toHaveBeenCalled();
  });
  it("настоящий сбой ИИ по-прежнему уходит на повтор", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("pendingAiReply").updateMany.mockResolvedValue({ count: 1 });
    await retryPendingAiReplies();
    expect(db.model("pendingAiReply").delete).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").update).toHaveBeenCalled();
  });
});

describe("пункт 6: сторож не гоняется с очередью в конце паузы", () => {
  const inAt = new Date(Date.now() + 60_000);
  const now = new Date(Date.now() + 10 * 60_000);
  function setup(anchorMinBeforeIn: number) {
    db.model("message").findMany.mockResolvedValue([{ contactId: "contact-1", createdAt: inAt, text: "Сколько стоит курс?" }]);
    db.model("message").count.mockResolvedValue(0);
    db.model("message").findUnique.mockResolvedValue({ text: "Приходите, расскажу" });
    db.model("contact").findUnique.mockResolvedValue(
      fakeContact({
        name: "Зарина",
        humanTakenOverAt: new Date(inAt.getTime() - anchorMinBeforeIn * 60_000),
        humanTakeoverMid: "m-x",
        humanSilencedUntil: null,
        humanRequestedAt: null,
        spamBlockedAt: null,
        whatsappSavedContact: false,
      }),
    );
  }
  it("пауза закончилась минуту назад: ждём очередь, тревоги нет", async () => {
    setup(17); // живое окно 25 мин закончилось ровно сейчас
    expect(await checkUnansweredInbound(now)).toBe(0);
  });
  it("пауза закончилась давно: тревога", async () => {
    setup(120);
    expect(await checkUnansweredInbound(now)).toBe(1);
  });
});

describe("пункт 9: профиль Instagram не запрашивается на каждое сообщение", () => {
  it("второй вызов для того же контакта не ходит в Graph; контакт с profileAt — тоже", async () => {
    SETTINGS.igToken = "t";
    SETTINGS.personalList = "mama_nick";
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const c = { id: "fresh-1", igUserId: "ig-9", channel: "INSTAGRAM", username: null, personal: false };
    expect(await markListedPersonalNow(c)).toBe(false);
    expect(await markListedPersonalNow(c)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await markListedPersonalNow({ ...c, id: "fresh-2", profileAt: new Date() })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    delete SETTINGS.igToken;
    delete SETTINGS.personalList;
  });
});

describe("корпус сценариев умного перехвата", () => {
  const config = { enabled: true, ...TAKEOVER_DEFAULTS };
  const t0 = new Date("2026-11-08T10:00:00Z");
  const min = (m: number) => new Date(t0.getTime() + m * 60_000);
  const scenarios: [string, Parameters<typeof decideTakeover>[0], unknown][] = [
    ["Ширин ответила 1 мин назад, клиентка пишет сразу", { config, anchor: t0, incomingAt: min(1), safeIntent: false, now: min(1) }, { action: "hold", until: min(13) }],
    ["терпение 12 мин вышло, Ширин молчит", { config, anchor: t0, incomingAt: min(1), safeIntent: false, now: min(14) }, { action: "answer", why: "idle" }],
    ["клиентка пишет через час после ручной реплики", { config, anchor: t0, incomingAt: min(60), safeIntent: false, now: min(60) }, { action: "answer", why: "cold" }],
    ["Ширин ответила уже после сообщения", { config, anchor: min(5), incomingAt: min(2), safeIntent: false, now: min(20) }, { action: "hold", until: null }],
    ["сутки без реплик", { config, anchor: t0, incomingAt: min(24 * 60 + 1), safeIntent: false, now: min(24 * 60 + 1) }, { action: "answer", why: "expired" }],
    ["безопасный запрос в разгар разговора", { config, anchor: t0, incomingAt: min(2), safeIntent: true, now: min(2) }, { action: "answer", why: "safe_intent" }],
    ["рубильник выключен", { config: { ...config, enabled: false }, anchor: t0, incomingAt: min(900), safeIntent: false, now: min(900) }, { action: "hold", until: null }],
  ];
  it.each(scenarios)("%s", (_name, input, expected) => expect(decideTakeover(input)).toEqual(expected));
  it.each([
    ["Рахмат", false, true],
    ["Спасибо большое", false, true],
    ["курс не открывается, дайте ссылку заново", true, true],
    ["курс не открывается, дайте ссылку заново", false, false],
    ["Сколько стоит?", true, false],
    ["Подробнее", false, false],
  ])("безопасное намерение «%s» (покупка: %s) -> %s", (t, purchase, expected) =>
    expect(isSafeIntent(t, purchase)).toBe(expected),
  );
});
