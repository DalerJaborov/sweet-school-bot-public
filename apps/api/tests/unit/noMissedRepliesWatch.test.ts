import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * КЛАСС A аудита 15.11.2026 («бот никого не пропускает»): клиент написал, пока бот
 * молчал по временной причине, тишина кончилась — и не ответил никто. Сторож смотрел
 * только на паузу после ответа Ширин в Instagram и только на сообщения, пришедшие
 * во время неё. Данные выдуманные.
 */
const aiReply = vi.fn(async () => undefined);
vi.mock("../../src/ai.js", () => ({ aiReply: (...a: unknown[]) => aiReply(...(a as [])) }));

import { runUnansweredWatch } from "../../src/unansweredWatch.js";
import { resetHumanSilenceMs } from "../../src/messaging/automation.js";
import { FOLLOW_PERSONAL_REASON } from "../../src/profiles.js";

const MIN = 60_000;
const NOW = new Date("2026-11-15T07:00:00Z");

let db: PrismaMock;
let settings: Record<string, string>;

function msg(direction: "IN" | "OUT", minutesAgo: number, text: string | null, mid: string | null = null) {
  return {
    id: `m-${minutesAgo}-${direction}`,
    mid,
    direction,
    text,
    payload: null,
    createdAt: new Date(NOW.getTime() - minutesAgo * MIN),
  };
}

function contactWith(messages: ReturnType<typeof msg>[], overrides: Record<string, unknown> = {}) {
  return {
    ...fakeContact(),
    channel: "INSTAGRAM",
    humanTakenOverAt: null,
    humanSilencedUntil: null,
    offlineHandoffAt: null,
    personalReason: null,
    spamBlockedAt: null,
    unansweredAlertAt: null,
    ...overrides,
    messages: [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

beforeEach(() => {
  db = mockPrisma();
  resetHumanSilenceMs();
  aiReply.mockClear();
  settings = { aiEnabled: "true" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  db.model("replyGate").findFirst.mockResolvedValue(null);
  db.model("pendingAiReply").findFirst.mockResolvedValue(null);
  db.model("webhookInbox").findFirst.mockResolvedValue(null);
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("КЛАСС A: тишина кончилась — бот отвечает сам", () => {
  it("бот сказал «сейчас уточню» (ждём Ширин час), клиент спросил ещё, Ширин не пришла — после часа отвечает бот", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 100, "Сейчас уточню и напишу вам"), msg("IN", 99, "Онлайн курс кай сар мешавад?")], {
        humanSilencedUntil: ago(40), // час «ждём Ширин» кончился 40 минут назад
        humanRequestedAt: ago(100),
      }),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).toHaveBeenCalledTimes(1);
    expect(aiReply.mock.calls[0][1]).toBe("Онлайн курс кай сар мешавад?");
  });

  it("Messenger: пауза после Ширин такая же временная — после неё бот отвечает", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 240, "Салом!"), msg("IN", 200, "Нархи курс чанд?")], {
        channel: "MESSENGER",
        humanTakenOverAt: ago(240),
      }),
    ]);
    await runUnansweredWatch(NOW);
    expect(db.model("contact").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ channel: { in: ["INSTAGRAM", "MESSENGER"] } }) }),
    );
    expect(aiReply).toHaveBeenCalledTimes(1);
  });

  it("клиент написал ПОСЛЕ конца паузы, ответ потерялся (сбой, рестарт, гонка эха) и решения молчать нет — бот отвечает", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 400, "Ҳа, апа"), msg("IN", 60, "Чекро ба куҷо фиристам?")], {
        humanTakenOverAt: ago(400),
      }),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).toHaveBeenCalledTimes(1);
  });

  it("решение «молчать» по этим сообщениям уже записано (ReplyGate silent) — сторож его уважает", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 400, "Ҳа"), msg("IN", 60, "Чи гап?")], { humanTakenOverAt: ago(400) }),
    ]);
    db.model("replyGate").findFirst.mockResolvedValue({ id: "decided" });
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(db.model("replyGate").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ action: "silent", createdAt: { gte: ago(60) } }) }),
    );
  });

  it("реакция на «рахмат» — решение про ТО сообщение; вопрос, заданный после, сторож всё равно подберёт", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 60, "Ссылка на курс"), msg("IN", 51, "Рахмат"), msg("IN", 30, "Дарс кай сар мешавад?")]),
    ]);
    const decidedAt = ago(50); // сердечко на «Рахмат»
    db.model("replyGate").findFirst.mockImplementation(async ({ where }: { where: { createdAt: { gte: Date } } }) =>
      where.createdAt.gte <= decidedAt ? { id: "reaction" } : null,
    );
    await runUnansweredWatch(NOW);
    expect(aiReply).toHaveBeenCalledTimes(1);
  });

  it("тишина ещё идёт (ждём Ширин) — сторож не встревает", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 30, "Сейчас уточню"), msg("IN", 20, "Хорошо, а цена?")], {
        humanSilencedUntil: new Date(NOW.getTime() + 30 * MIN),
      }),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("ход ещё в работе: очередь повторов ИИ — сторож не дублирует", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 240, "Салом!"), msg("IN", 200, "Нархи курс чанд?")], { humanTakenOverAt: ago(240) }),
    ]);
    db.model("pendingAiReply").findFirst.mockResolvedValue({ id: "queued" });
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("ход ещё в работе: вебхук этого сообщения не дообработан (повтор после сбоя) — сторож не дублирует", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 240, "Салом!"), msg("IN", 200, "Нархи курс чанд?", "mid-in-1")], {
        humanTakenOverAt: ago(240),
      }),
    ]);
    db.model("webhookInbox").findFirst.mockResolvedValue({ id: "retrying" });
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(db.model("webhookInbox").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: { in: ["PENDING", "PROCESSING"] }, OR: [{ eventKey: { endsWith: ":message:mid-in-1" } }] },
      }),
    );
  });

  it("только фото без текста — бот не гадает, но решение записано в журнал (один раз на ожидание)", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 240, "Салом!"), msg("IN", 200, null)], { humanTakenOverAt: ago(240) }),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unansweredAlertAt: NOW } }),
    );
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "silent", reason: expect.stringMatching(/^media_only/) }),
      }),
    );
  });

  it("«знакомые» (на них подписана Ширин) и ручной «личный» — не клиенты, сторож молчит", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 60, "Курс чанд?")], { personal: true, personalReason: FOLLOW_PERSONAL_REASON }),
      contactWith([msg("IN", 60, "Курс чанд?")], { id: "c2", personal: true, personalReason: "мама" }),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
  });
});
