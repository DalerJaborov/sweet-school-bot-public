import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * КЛАСС A аудита 15.11.2026 («бот никого не пропускает»): клиент написал, пока бот
 * молчал по временной причине, тишина кончилась — и не ответил никто. Сторож смотрел
 * только на паузу после ответа Ширин в Instagram и только на сообщения, пришедшие
 * во время неё. Данные выдуманные.
 */
const aiReply = vi.fn(async (..._a: unknown[]) => undefined);
const offlinePaused = vi.fn(async (..._a: unknown[]) => false);
vi.mock("../../src/ai.js", () => ({
  aiReply: (...a: unknown[]) => aiReply(...a),
  offlineRepliesPausedFor: (...a: unknown[]) => offlinePaused(...a),
}));
const sendKind = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/notify.js", () => ({ sendKind: (...a: unknown[]) => sendKind(...a) }));

import { runUnansweredWatch, setWatchStartedAt } from "../../src/unansweredWatch.js";
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
  db.model("receiptCheck").findFirst.mockResolvedValue(null);
  db.model("message").findFirst.mockResolvedValue(null);
  db.model("message").findMany.mockResolvedValue([{ contactId: "contact-1" }]);
  sendKind.mockClear();
  setWatchStartedAt(0);
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
    expect(db.model("message").findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contact: expect.objectContaining({ channel: { in: ["INSTAGRAM", "MESSENGER"] } }),
        }),
      }),
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

  it("только фото без текста — бот не гадает, но «ждём разбора» записано в журнал (один раз на ожидание)", async () => {
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
        data: expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^media_only/) }),
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

/** Ревью PR #96 (15.11.2026): каждая проверка падала бы на первой версии сторожа. */
describe("ревью: сторож не делает хуже", () => {
  const pausedBuyer = (messages: ReturnType<typeof msg>[], overrides: Record<string, unknown> = {}) =>
    contactWith(messages, { humanTakenOverAt: ago(400), ...overrides });

  it("п.1 чек на проверке после последнего ответа + «Оплатила» — бот не говорит «чек не вижу», а ждёт разбора", async () => {
    db.model("contact").findMany.mockResolvedValue([
      pausedBuyer([msg("OUT", 400, "Реквизиты"), msg("IN", 60, "Оплатила")]),
    ]);
    db.model("receiptCheck").findFirst.mockResolvedValue({ id: "rc-1" });
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "contact-1", createdAt: { gte: ago(60) } } }),
    );
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^media_only/) }),
      }),
    );
  });

  it("п.1 фото без подписи и следом «Оплатила» — тоже не отвечаем текстом", async () => {
    db.model("contact").findMany.mockResolvedValue([
      pausedBuyer([msg("OUT", 400, "Реквизиты"), msg("IN", 61, null), msg("IN", 60, "Оплатила")]),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("п.2 кандидаты — по последнему входящему, свежие первыми, без дублей; порядок обхода тот же", async () => {
    db.model("message").findMany.mockResolvedValue([{ contactId: "c-new" }, { contactId: "c-old" }]);
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 300, "Курс чанд?")], { id: "c-old" }),
      contactWith([msg("IN", 30, "Онлайн аст?")], { id: "c-new" }),
    ]);
    await runUnansweredWatch(NOW);
    expect(db.model("message").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" }, distinct: ["contactId"], select: { contactId: true } }),
    );
    expect(db.model("contact").findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["c-new", "c-old"] } } }),
    );
    expect(aiReply.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["c-new", "c-old"]);
  });

  it("п.3 ответ упал (Meta 500) — отметка возвращается, следующий тик попробует снова", async () => {
    const prev = ago(500);
    db.model("contact").findMany.mockResolvedValue([
      pausedBuyer([msg("OUT", 400, "Ҳа"), msg("IN", 60, "Нарх чанд?")], { unansweredAlertAt: prev }),
    ]);
    aiReply.mockRejectedValueOnce(new Error("Meta 500"));
    db.model("replyGate").count.mockResolvedValue(1);
    await runUnansweredWatch(NOW);
    expect(db.model("contact").updateMany).toHaveBeenLastCalledWith({
      where: { id: "contact-1", unansweredAlertAt: NOW },
      data: { unansweredAlertAt: prev },
    });
  });

  it("п.3 три сбоя подряд — больше не пробуем (потолок попыток)", async () => {
    db.model("contact").findMany.mockResolvedValue([pausedBuyer([msg("OUT", 400, "Ҳа"), msg("IN", 60, "Нарх чанд?")])]);
    aiReply.mockRejectedValueOnce(new Error("Meta 500"));
    db.model("replyGate").count.mockResolvedValue(3);
    await runUnansweredWatch(NOW);
    expect(db.model("contact").updateMany).toHaveBeenCalledTimes(1); // только сама отметка
  });

  it("п.4 клиент САМ просил человека, Ширин не ответила — бот не возвращается, Ширин напоминаем один раз", async () => {
    const asked = contactWith([msg("OUT", 120, "Ширин скоро ответит"), msg("IN", 50, "Ну где вы?")], {
      humanRequestedAt: ago(120),
      humanSilencedUntil: ago(60),
    });
    db.model("contact").findMany.mockResolvedValue([asked]);
    db.model("replyGate").findFirst.mockImplementation(
      async ({ where }: { where: { reason?: { startsWith: string } } }) =>
        where.reason?.startsWith === "asked_human:" ? { id: "asked" } : null,
    );
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendKind).toHaveBeenCalledTimes(1);
    expect(sendKind.mock.calls[0][0]).toBe("human");
    expect(String(sendKind.mock.calls[0][1])).toContain("Ну где вы?");
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: expect.stringMatching(/^asked_human_reminded/) }),
      }),
    );
  });

  it("пауза по офлайну: бот молчит нарочно — Ширин напоминаем в Telegram один раз, бот не отвечает", async () => {
    offlinePaused.mockResolvedValue(true);
    db.model("contact").findMany.mockResolvedValue([contactWith([msg("OUT", 120, "Карточка"), msg("IN", 50, "А адрес?")])]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendKind).toHaveBeenCalledTimes(1);
    expect(sendKind.mock.calls[0][0]).toBe("human");
    const text = String(sendKind.mock.calls[0][1]);
    expect(text).toContain("офлайн");
    expect(text).toContain("А адрес?");
    offlinePaused.mockResolvedValue(false);
  });

  it("п.4 напоминание было меньше часа назад — Ширин не тревожим и ожидание не закрываем (напомним позже)", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("OUT", 120, "Ширин скоро ответит"), msg("IN", 20, "Алло?")], {
        humanRequestedAt: ago(120),
        humanSilencedUntil: ago(60),
      }),
    ]);
    db.model("replyGate").findFirst.mockImplementation(
      async ({ where }: { where: { reason?: { startsWith: string } } }) => (where.reason ? { id: "row" } : null),
    );
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendKind).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("п.4 просьба до журнала решений узнаётся по самому сообщению «позовите человека»", async () => {
    db.model("contact").findMany.mockResolvedValue([
      contactWith(
        [msg("IN", 121, "Позовите живого человека"), msg("OUT", 120, "Ширин скоро ответит"), msg("IN", 50, "Ну?")],
        {
          humanRequestedAt: ago(120),
          humanSilencedUntil: ago(60),
        },
      ),
    ]);
    db.model("message")
      .findMany.mockResolvedValueOnce([{ contactId: "contact-1" }])
      .mockResolvedValueOnce([{ text: "Позовите живого человека" }]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendKind).toHaveBeenCalledTimes(1);
  });

  it("п.5 ждал больше двух часов — сторож передаёт, сколько ждал (бот извинится за задержку)", async () => {
    db.model("contact").findMany.mockResolvedValue([
      pausedBuyer([msg("OUT", 400, "Ҳа"), msg("IN", 190, "Нарх чанд?")]),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply.mock.calls[0][4]).toEqual({ waitedMs: 190 * MIN });
  });

  it("п.5 первый запуск после выкатки: ждущее с прошлого дня (старше 6 ч) не трогаем, свежее — отвечаем", async () => {
    setWatchStartedAt(NOW.getTime());
    db.model("message").findMany.mockResolvedValue([{ contactId: "c-day" }, { contactId: "contact-1" }]);
    db.model("contact").findMany.mockResolvedValue([
      contactWith([msg("IN", 7 * 60, "Курс чанд?")], { id: "c-day" }),
      contactWith([msg("IN", 5 * 60, "Онлайн аст?")]),
    ]);
    await runUnansweredWatch(NOW);
    expect(aiReply.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["contact-1"]);
  });

  it("п.6 отметка ставится только если после этого входящего в переписке ничего не появилось", async () => {
    db.model("contact").findMany.mockResolvedValue([pausedBuyer([msg("OUT", 400, "Ҳа"), msg("IN", 60, "Нарх чанд?")])]);
    db.model("contact").updateMany.mockResolvedValue({ count: 0 }); // успели ответить между выборкой и отметкой
    await runUnansweredWatch(NOW);
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ messages: { none: { createdAt: { gt: ago(60) } } } }),
      }),
    );
    expect(aiReply).not.toHaveBeenCalled();
  });
});

/** Решение владельца 15.11.2026: «позовите человека» — отвечает только Ширин, бот молчит до её ответа. */
describe("«позовите человека»: бот молчит до ответа Ширин, Ширин — напоминания без спама", () => {
  const HOLD = new Date("2999-01-01T00:00:00Z");
  const holdContact = (messages: ReturnType<typeof msg>[]) =>
    contactWith(messages, { humanRequestedAt: ago(5 * 60), humanSilencedUntil: HOLD });

  it("клиент снова написал — бот не отвечает, Ширин получает одно напоминание", async () => {
    db.model("contact").findMany.mockResolvedValue([holdContact([msg("OUT", 300, "Ширин скоро ответит"), msg("IN", 30, "Жду ответа")])]);
    await runUnansweredWatch(NOW);
    expect(aiReply).not.toHaveBeenCalled();
    expect(sendKind).toHaveBeenCalledTimes(1);
    expect(String(sendKind.mock.calls[0][1])).toContain("Жду ответа");
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: expect.stringMatching(/^asked_human_reminded/) }) }),
    );
  });

  it("не чаще раза в час: напоминание было 20 минут назад — молчим", async () => {
    db.model("contact").findMany.mockResolvedValue([holdContact([msg("OUT", 300, "Ширин скоро ответит"), msg("IN", 30, "Когда ответите про курс?")])]);
    db.model("replyGate").findFirst.mockImplementation(
      async ({ where }: { where: { reason?: { startsWith: string }; createdAt?: { gte: Date } } }) =>
        where.reason?.startsWith === "asked_human_reminded:" && where.createdAt && where.createdAt.gte <= ago(20) ? { id: "r" } : null,
    );
    await runUnansweredWatch(NOW);
    expect(sendKind).not.toHaveBeenCalled();
  });

  it("прошлое напоминание больше часа назад, клиент написал снова — напоминаем ещё раз", async () => {
    db.model("contact").findMany.mockResolvedValue([holdContact([msg("OUT", 300, "Ширин скоро ответит"), msg("IN", 30, "Когда ответите про курс?")])]);
    db.model("replyGate").findFirst.mockImplementation(
      async ({ where }: { where: { reason?: { startsWith: string }; createdAt?: { gte: Date } } }) =>
        where.reason?.startsWith === "asked_human_reminded:" && where.createdAt && where.createdAt.gte <= ago(90) ? { id: "r" } : null,
    );
    await runUnansweredWatch(NOW);
    expect(sendKind).toHaveBeenCalledTimes(1);
    expect(aiReply).not.toHaveBeenCalled();
  });
});
