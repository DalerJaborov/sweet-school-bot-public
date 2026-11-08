import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const notifyOwnerDirect = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../src/systemAlerts.js", () => ({ notifyOwnerDirect: (...a: unknown[]) => notifyOwnerDirect(...a) }));
const shouldSendAlert = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../src/alertGate.js", () => ({ shouldSendAlert: (...a: unknown[]) => shouldSendAlert(...a) }));
const heal = vi.fn(async () => 0);
vi.mock("../../src/ai/takeoverHeal.js", () => ({ healFalseTakeovers: () => heal() }));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key"]) }));

import { checkUnansweredInbound } from "../../src/inboundWatch.js";
import { noteDeliberateSilence, resetDeliberateSilence } from "../../src/ai/deliberateSilence.js";
import { guardOffTopic } from "../../src/ai/offTopicGuard.js";
import { trackOwnSend, resetOwnSendLedger } from "../../src/ai/ownSendLedger.js";

const realHeal = async (): Promise<number> =>
  (await vi.importActual<typeof import("../../src/ai/takeoverHeal.js")>("../../src/ai/takeoverHeal.js")).healFalseTakeovers();

let db: PrismaMock;
const SETTINGS: Record<string, string> = { aiEnabled: "true", timezoneOffsetHours: "5" };
/** Входящее пришло через минуту после старта процесса, «сейчас» — спустя 10 минут. */
const inAt = new Date(Date.now() + 60_000);
const now = new Date(Date.now() + 10 * 60_000);

function setup(opts: { contact?: Record<string, unknown>; text?: string | null; outCount?: number; inAtOverride?: Date } = {}) {
  db.model("message").findMany.mockResolvedValue([
    { contactId: "contact-1", createdAt: opts.inAtOverride ?? inAt, text: opts.text === undefined ? "Сколько стоит курс?" : opts.text },
  ]);
  db.model("message").count.mockResolvedValue(opts.outCount ?? 0);
  db.model("contact").findUnique.mockResolvedValue(
    fakeContact({ name: "Зарина", humanTakenOverAt: null, humanSilencedUntil: null, humanRequestedAt: null, spamBlockedAt: null, whatsappSavedContact: false, ...opts.contact })
  );
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  notifyOwnerDirect.mockClear();
  shouldSendAlert.mockClear().mockResolvedValue(true);
  heal.mockClear();
  resetDeliberateSilence();
  resetOwnSendLedger();
});
afterEach(() => { restorePrisma(); vi.restoreAllMocks(); });

describe("сторож неотвеченных: тревога, когда бот молчит без причины", () => {
  it("ГЛАВНОЕ: сообщение без ответа 9 минут, бот включён — тревога с именем и причиной", async () => {
    setup();
    expect(await checkUnansweredInbound(now)).toBe(1);
    const text = String(notifyOwnerDirect.mock.calls[0][0]);
    expect(text).toContain("Зарина");
    expect(text).toContain("Сколько стоит курс?");
    expect(text).toContain("Причина:");
    expect(heal).toHaveBeenCalled(); // самолечение идёт раньше сторожа
  });

  it("ложная пауза от эха попадает в причину: «передано человеку», ответа нет", async () => {
    setup({ contact: { humanTakenOverAt: new Date(inAt.getTime() - 3_600_000), humanTakeoverMid: "m-x" } });
    db.model("message").findUnique.mockResolvedValue({ text: "[картинка воронки]" });
    await checkUnansweredInbound(now);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("передано человеку");
  });

  it("меньше двух минут — ещё рано", async () => {
    setup({ inAtOverride: new Date(now.getTime() - 90_000) });
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("на сообщение кто-то ответил (бот или живая хозяйка) — тишины нет", async () => {
    setup({ outCount: 1 });
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("бот выключен владельцем — не тревожим", async () => {
    setup();
    SETTINGS.aiEnabled = "false";
    expect(await checkUnansweredInbound(now)).toBe(0);
    SETTINGS.aiEnabled = "true";
  });

  it("рубильник unansweredAlertEnabled=false выключает сторож", async () => {
    setup();
    SETTINGS.unansweredAlertEnabled = "false";
    expect(await checkUnansweredInbound(now)).toBe(0);
    delete SETTINGS.unansweredAlertEnabled;
  });

  it.each([
    ["личный контакт", { personal: true }],
    ["спам-блок", { spamBlockedAt: new Date() }],
    ["контакт хозяйки в WhatsApp", { whatsappSavedContact: true }],
    ["просили позвать человека", { humanRequestedAt: new Date(inAt.getTime() + 5_000) }],
  ])("намеренное молчание не тревожит: %s", async (_name, contact) => {
    setup({ contact });
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("«спасибо» без вопроса — бот ставит реакцию, тревоги нет", async () => {
    setup({ text: "Спасибо" });
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("молчание с записанной причиной (просят бесплатно, NO_REPLY) не тревожит", async () => {
    setup();
    // Запись делается ПОСЛЕ входящего — как в боевом порядке (ai.ts решает, получив сообщение).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(inAt.getTime() + 3_000));
    noteDeliberateSilence("contact-1", "молчаливый вид «freeloader»");
    vi.useRealTimers();
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("отказ шлюза «не по делу» — запись журнала шлюза считается причиной", async () => {
    setup();
    db.model("replyGate").findFirst.mockResolvedValue({ reason: "курьер" });
    expect(await checkUnansweredInbound(now)).toBe(0);
  });

  it("одна тревога на одно сообщение: повтор по тому же ключу не уходит", async () => {
    setup();
    shouldSendAlert.mockResolvedValue(false);
    expect(await checkUnansweredInbound(now)).toBe(0);
    expect(notifyOwnerDirect).not.toHaveBeenCalled();
  });

  it("вложение без текста тоже считается сообщением клиента", async () => {
    setup({ text: null });
    await checkUnansweredInbound(now);
    expect(String(notifyOwnerDirect.mock.calls[0][0])).toContain("вложение без текста");
  });
});

describe("самолечение ложного «передано человеку»", () => {
  const sameText = "Ҳа, ин курс 70 сомонӣ";
  const t0 = new Date("2026-11-08T10:00:00Z");

  function arrange(opts: { twinText?: string | null; ownMid?: string }) {
    db.model("contact").findMany.mockResolvedValue([{ id: "contact-1", humanTakeoverMid: "mid-echo" }]);
    db.model("message").findUnique.mockResolvedValue({ mid: "mid-echo", byHuman: true, direction: "OUT", text: sameText, createdAt: t0 });
    db.model("message").findMany.mockResolvedValue(opts.twinText === null ? [] : [{ text: opts.twinText ?? sameText }]);
    db.model("contact").findUnique.mockResolvedValue(
      fakeContact({ humanTakenOverAt: t0, humanTakeoverMid: "mid-echo" })
    );
    db.model("message").findFirst.mockResolvedValue(null); // настоящих реплик хозяйки позже нет
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  }

  it("тот же текст уже отправил бот в окне 3 минут — пауза снимается, сообщение больше не «хозяйкино»", async () => {
    arrange({});
    expect(await realHeal()).toBe(1);
    expect(db.model("message").update).toHaveBeenCalledWith({ where: { mid: "mid-echo" }, data: { byHuman: false } });
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { humanTakenOverAt: null, humanTakeoverMid: null } })
    );
  });

  it("текст не совпал — это настоящая хозяйка, пауза остаётся", async () => {
    arrange({ twinText: "Совсем другое сообщение бота" });
    expect(await realHeal()).toBe(0);
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("бот ничего похожего не отправлял — пауза остаётся", async () => {
    arrange({ twinText: null });
    expect(await realHeal()).toBe(0);
  });

  it("mid подтверждён журналом отправок (текста нет — вложение) — пауза снимается", async () => {
    arrange({ twinText: null });
    db.model("message").findUnique.mockResolvedValue({ mid: "mid-echo", byHuman: true, direction: "OUT", text: null, createdAt: t0 });
    await trackOwnSend("ig-1", null, async () => ({ message_id: "mid-echo" }));
    expect(await realHeal()).toBe(1);
  });

  it("если после ложного эха хозяйка написала сама — пауза переезжает на её реплику, а не снимается", async () => {
    arrange({});
    db.model("message").findFirst.mockResolvedValue({ mid: "mid-real", createdAt: new Date(t0.getTime() + 60_000) });
    await realHeal();
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { humanTakenOverAt: new Date(t0.getTime() + 60_000), humanTakeoverMid: "mid-real" } })
    );
  });
});

describe("фильтр молчания: наши собственные предложения не считаются попрошайничеством", () => {
  it.each([
    "Здравствуйте, а где бесплатный урок?",
    "Хочу бесплатный урок",
    "бепул дарс дорем?",
    "Дарси ройгон кай мешавад",
    "Денег нет пока, есть рассрочка?",
  ])("«%s» → отвечает бот, не молчит", (text) => {
    expect(guardOffTopic(text)?.kind).not.toBe("freeloader");
  });

  it.each(["дайте курс бесплатно", "пустите так", "ройгон диҳед"])("«%s» → осознанное молчание сохранено", (text) => {
    expect(guardOffTopic(text)?.kind).toBe("freeloader");
  });
});
