import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * СТОРОЖ «БЕЗ ОТВЕТА» (владелец 09.11.2026): «никто не должен оставаться без
 * ответа — и в комментах, и в личных сообщениях Instagram».
 */
const aiReply = vi.fn(async () => undefined);
vi.mock("../../src/ai.js", () => ({ aiReply: (...a: unknown[]) => aiReply(...(a as [])) }));
const sendTelegramMessage = vi.fn(async () => undefined);
vi.mock("../../src/telegram.js", () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...(a as [])),
  summaryChatIds: vi.fn(async () => ["shirin-chat"]),
}));
vi.mock("../../src/funnel.js", () => ({ COMMENT_WAITING_OUTCOMES: ["waiting_human", "ai_off", "no_keys", "budget", "ai_error"] }));

import { runUnansweredWatch, needsAnswer } from "../../src/unansweredWatch.js";
import { resetHumanSilenceMs } from "../../src/messaging/automation.js";
import { FOLLOW_PERSONAL_REASON } from "../../src/profiles.js";

const MIN = 60_000;
/** 12:00 по Душанбе (UTC+5) — рабочее время. */
const NOON = new Date("2026-11-09T07:00:00Z");
/** 23:30 по Душанбе — ночь. */
const NIGHT = new Date("2026-11-09T18:30:00Z");

let db: PrismaMock;
let settings: Record<string, string>;

function msg(direction: "IN" | "OUT", minutesAgo: number, text: string | null, now = NOON) {
  return { id: `m-${Math.random()}`, direction, text, payload: null, createdAt: new Date(now.getTime() - minutesAgo * MIN) };
}

function contactWith(messages: ReturnType<typeof msg>[], overrides: Record<string, unknown> = {}) {
  return {
    ...fakeContact(),
    humanTakenOverAt: null,
    humanSilencedUntil: null,
    offlineHandoffAt: null,
    personalReason: null,
    spamBlockedAt: null,
    unansweredAlertAt: null,
    ...overrides,
    // От новых к старым — как отдаёт запрос сторожа.
    messages: [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}

beforeEach(() => {
  db = mockPrisma();
  resetHumanSilenceMs();
  aiReply.mockClear();
  sendTelegramMessage.mockClear();
  settings = { aiEnabled: "true", telegramBotToken: "bot", timezoneOffsetHours: "5" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  db.model("seenComment").updateMany.mockResolvedValue({ count: 1 });
  db.model("seenComment").findMany.mockResolvedValue([]);
  db.model("replyGate").findFirst.mockResolvedValue(null);
  db.model("message").findFirst.mockResolvedValue(null);
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

const telegramText = (): string => sendTelegramMessage.mock.calls[0]?.[2] as unknown as string;

describe("сторож: директ Instagram", () => {
  it("ГЛАВНОЕ: Ширин ответила 4 часа назад, клиент спросил во время паузы — бот отвечает сам", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 240, "Салом!"), msg("IN", 200, "Нархи курс чанд?"), msg("IN", 199, "Онлайн")], {
        humanTakenOverAt: new Date(NOON.getTime() - 240 * MIN),
      }),
    ]);
    db.model("message").findFirst.mockResolvedValue({ id: "answer" }); // бот ответил
    await runUnansweredWatch(NOON);
    expect(aiReply).toHaveBeenCalledTimes(1);
    expect(aiReply.mock.calls[0][1]).toBe("Нархи курс чанд?\nОнлайн");
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { unansweredAlertAt: NOON } }));
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("пауза ещё идёт — бот не встревает, Ширин получает напоминание с временем конца паузы", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Ҳа"), msg("IN", 30, "Кай сар мешавад?")], { humanTakenOverAt: new Date(NOON.getTime() - 60 * MIN) }),
    ]);
    await runUnansweredWatch(NOON);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith("bot", "shirin-chat", expect.any(String));
    expect(telegramText()).toContain("@client");
    expect(telegramText()).toContain("Кай сар мешавад?");
    expect(telegramText()).toContain("до 14:00");
  });

  it("офлайн передан Ширин — бот молчит, но напоминание уходит", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Карточка"), msg("IN", 20, "А адрес?")], { offlineHandoffAt: new Date(NOON.getTime() - 60 * MIN) }),
    ]);
    await runUnansweredWatch(NOON);
    expect(aiReply).not.toHaveBeenCalled();
    expect(telegramText()).toContain("офлайн");
  });

  it("«спасибо», «ок», смайлик — ответа не ждут, никого не будим", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Ссылка"), msg("IN", 30, "Рахмат")]),
      contactWith([msg("OUT", 60, "Ссылка"), msg("IN", 30, "ок 👍")], { id: "c2" }),
    ]);
    await runUnansweredWatch(NOON);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("ручная отметка «личный» — не трогаем; авто «знакомая» — напоминаем", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 30, "Курс чанд?")], { personal: true, personalReason: "Отмечен вручную" }),
      contactWith([msg("IN", 30, "Курс чанд?")], { id: "c2", username: "friend", personal: true, personalReason: FOLLOW_PERSONAL_REASON }),
    ]);
    await runUnansweredWatch(NOON);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(telegramText()).toContain("@friend");
    expect(telegramText()).not.toContain("@client");
  });

  it("свежее (младше 15 минут) и уже напомненное — пропускаем", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 5, "Курс чанд?")]),
      contactWith([msg("IN", 30, "Курс чанд?")], { id: "c2", unansweredAlertAt: new Date(NOON.getTime() - 10 * MIN) }),
    ]);
    await runUnansweredWatch(NOON);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("фильтр «не по делу» уже решил молчать (курьер, магазин) — не напоминаем", async () => {
    db.model("contact").findMany.mockResolvedValue([contactWith([msg("IN", 30, "Курьер внизу, заберите посылку")])]);
    db.model("replyGate").findFirst.mockResolvedValue({ id: "gate" });
    await runUnansweredWatch(NOON);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ночью Telegram не будим и ожидание не помечаем — напомним утром", async () => {
    db.model("contact").findMany.mockResolvedValue([contactWith([msg("IN", 30, "Курс чанд?", NIGHT)], { offlineHandoffAt: new Date() })]);
    await runUnansweredWatch(NIGHT);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("рубильник выключен — сторож ничего не делает", async () => {
    settings.unansweredWatchdogEnabled = "false";
    await runUnansweredWatch(NOON);
    expect(db.model("contact").findMany).not.toHaveBeenCalled();
  });

  it("не чаще раза в 15 минут: только что писали — копим до следующего раза", async () => {
    settings.unansweredWatchSentAt = String(NOON.getTime() - 5 * MIN);
    db.model("contact").findMany.mockResolvedValue([contactWith([msg("IN", 30, "Курс чанд?")], { offlineHandoffAt: new Date() })]);
    await runUnansweredWatch(NOON);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
});

describe("сторож: комментарии", () => {
  it("комментарий без ответа не по нашему решению — в напоминание; ответили потом в директ — нет", async () => {
    db.model("contact").findMany.mockImplementation(async (args: unknown) =>
      (args as { where: { id?: unknown } }).where.id ? [{ id: "c1", username: "commenter", igUserId: "1" }] : [],
    );
    db.model("seenComment").findMany.mockResolvedValue([
      { commentId: "k1", contactId: "c1", text: "Нарх чанд?", outcome: "ai_off", createdAt: new Date(NOON.getTime() - 40 * MIN) },
      { commentId: "k2", contactId: "c2", text: "Курс кай?", outcome: "budget", createdAt: new Date(NOON.getTime() - 40 * MIN) },
    ]);
    db.model("message").findFirst.mockImplementation(async (args: unknown) =>
      (args as { where: { contactId: string } }).where.contactId === "c2" ? { id: "dm" } : null,
    );
    await runUnansweredWatch(NOON);
    expect(telegramText()).toContain("Комментарии без ответа");
    expect(telegramText()).toContain("@commenter");
    expect(telegramText()).toContain("выключены");
    expect(telegramText()).not.toContain("Курс кай?");
  });
});

describe("что считается «ждёт ответа»", () => {
  const m = (text: string | null, payload: string | null = null) => ({ text, payload });
  it.each(["Салом", "+", "???", "Нархи курс чанд?", "а когда начало?"])("«%s» — ждёт ответа", (t) => {
    expect(needsAnswer(m(t))).toBe(true);
  });
  it.each(["Рахмат", "спасибо большое", "ок", "хоб", "❤️", "👍👍"])("«%s» — пустое подтверждение", (t) => {
    expect(needsAnswer(m(t))).toBe(false);
  });
  it("фото/голос без текста и нажатая кнопка — ждут ответа", () => {
    expect(needsAnswer(m(null))).toBe(true);
    expect(needsAnswer(m("Ҳа", "step:f:2"))).toBe(true);
  });
  it("«пустите бесплатно» — нарочное молчание владельца, не напоминаем", () => {
    expect(needsAnswer(m("Курсро бепул диҳед"))).toBe(false);
  });
});
