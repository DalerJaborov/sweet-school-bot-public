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
  techChatIds: vi.fn(async () => ["tech-chat"]),
}));
vi.mock("../../src/funnel.js", () => ({ COMMENT_WAITING_OUTCOMES: ["waiting_human", "ai_off", "no_keys", "budget", "ai_error"] }));

import { runUnansweredWatch } from "../../src/unansweredWatch.js";
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
  settings = { aiEnabled: "true", telegramBotToken: "bot", timezoneOffsetHours: "5", telegramOwnerChatId: "owner-chat" };
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

  it("пауза ещё идёт — бот не встревает и в Telegram НЕ пишет (11.11.2026: «Ждут ответа» — шум)", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Ҳа"), msg("IN", 30, "Кай сар мешавад?")], { humanTakenOverAt: new Date(NOON.getTime() - 60 * MIN) }),
    ]);
    await runUnansweredWatch(NOON);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("офлайн передан Ширин, «знакомая», клиент просил человека — бот молчит и никому не пишет", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Карточка"), msg("IN", 20, "А адрес?")], { offlineHandoffAt: new Date(NOON.getTime() - 60 * MIN) }),
      contactWith([msg("IN", 30, "Курс чанд?")], { id: "c2", username: "friend", personal: true, personalReason: FOLLOW_PERSONAL_REASON }),
    ]);
    await runUnansweredWatch(NOON);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("КЛАСС: сторож не отправляет в Telegram ни при каких входных данных (дневное и ночное время)", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 30, "Курс чанд?")]),
      contactWith([msg("IN", 30, "Курс чанд?", NIGHT)], { id: "c2" }),
    ]);
    await runUnansweredWatch(NOON);
    await runUnansweredWatch(NIGHT);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("«спасибо», «ок», смайлик — ответа не ждут", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Ссылка"), msg("IN", 30, "Рахмат")]),
      contactWith([msg("OUT", 60, "Ссылка"), msg("IN", 30, "ок 👍")], { id: "c2" }),
    ]);
    await runUnansweredWatch(NOON);
    expect(aiReply).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("рубильник выключен — сторож ничего не делает", async () => {
    settings.unansweredWatchdogEnabled = "false";
    await runUnansweredWatch(NOON);
    expect(db.model("contact").findMany).not.toHaveBeenCalled();
  });
});
