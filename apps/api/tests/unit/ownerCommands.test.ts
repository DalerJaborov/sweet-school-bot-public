import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { parseOwnerCommand } from "../../src/ownerCommands.js";

const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
const sendWithMarkup = vi.fn(async (..._a: unknown[]) => true);
const answerCallback = vi.fn(async (..._a: unknown[]) => undefined);
const editMessageWithMarkup = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../src/telegram.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/telegram.js")>("../../src/telegram.js");
  return {
    ...actual,
    sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
    sendWithMarkup: (...a: unknown[]) => sendWithMarkup(...a),
    answerCallback: (...a: unknown[]) => answerCallback(...a),
    editMessageWithMarkup: (...a: unknown[]) => editMessageWithMarkup(...a),
  };
});

import { handleOwnerWords, handleControlCallback } from "../../src/telegramControl.js";
import { chatsForKind } from "../../src/telegram.js";

describe("простые слова владельца → действие", () => {
  const cases: [string, unknown][] = [
    ["не присылай мне оплаты", { type: "mute", kinds: ["payment"] }],
    ["Не отправляй мне итог дня", { type: "mute", kinds: ["day"] }],
    ["не присылай мне про офлайн записи", { type: "mute", kinds: ["offline"] }],
    ["выключи уведомления про сбои", { type: "mute", kinds: ["failure"] }],
    ["не присылай мне такое", { type: "askMute" }],
    ["не отправляй", { type: "askMute" }],
    ["выключи бота", { type: "askBotOff" }],
    ["не пиши клиентам", { type: "askBotOff" }],
    ["выключи ии", { type: "ai", on: false }],
    ["включи ии", { type: "askBotOn", what: "ai" }],
    ["включи бота", { type: "askBotOn", what: "all" }],
    ["верни бота", { type: "askBotOn", what: "all" }],
    ["пауза", { type: "freeze", on: true }],
    ["сними паузу", { type: "askBotOn", what: "freeze" }],
    ["выключи воронку", { type: "funnels", on: false }],
    ["включи воронку", { type: "askBotOn", what: "funnels" }],
    ["включи ответы под комментариями", { type: "askBotOn", what: "comments" }],
    ["поставь воронку на паузу", { type: "funnels", on: false }],
    ["не отвечай под комментариями", { type: "comments", on: false }],
    ["что у меня выключено", { type: "whatOff" }],
    ["включи обратно", { type: "unmuteAll" }],
    ["включи оплаты", { type: "askUnmute", kinds: ["payment"] }],
    ["включи уведомления про оплаты", { type: "unmute", kinds: ["payment"] }],
    ["присылай мне оплаты", { type: "unmute", kinds: ["payment"] }],
    ["меню", { type: "menu" }],
  ];
  for (const [text, expected] of cases) {
    it(`«${text}»`, () => expect(parseOwnerCommand(text)).toEqual(expected));
  }
  it("«не пишите» / «не пишет» — слова с продолжением не ловятся как «не пиши»", () => {
    for (const t of ["не пишите мне про оплаты", "не пишет в сообщения", "не присылаете оплаты"]) {
      expect(parseOwnerCommand(t), t).toBeNull();
    }
    expect(parseOwnerCommand("не пиши мне про оплаты")).toEqual({ type: "mute", kinds: ["payment"] });
    expect(parseOwnerCommand("перестань присылать оплаты")).toEqual({ type: "mute", kinds: ["payment"] });
  });
  it("«верни доступ @имя» — про человека, а не про уведомления: не включает вид «безопасность»", () => {
    expect(parseOwnerCommand("верни доступ @anna")).toBeNull();
    expect(parseOwnerCommand("верни доступ")).toEqual({ type: "askUnmute", kinds: ["security"] });
  });
  it("обычная речь и вопросы ученицам — не команда", () => {
    for (const t of ["Спасибо, Малика!", "Выдай ссылку @anna", "привет", "курс 70 сомони, пришлите реквизиты", ""]) {
      expect(parseOwnerCommand(t), t).toBeNull();
    }
  });
});

const SHIRIN = "7916128767";
const DALER = "893446307";
let db: PrismaMock;
let settings: Record<string, string>;

beforeEach(() => {
  db = mockPrisma();
  settings = { telegramBotToken: "tok", telegramOwnerChatId: SHIRIN, telegramQaOwnerId: SHIRIN, telegramTechChatId: DALER };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("setting").upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    settings[where.key] = update.value;
    return {};
  });
  db.model("funnel").count.mockResolvedValue(0);
  db.model("funnel").findMany.mockResolvedValue([]);
  for (const f of [sendTelegramMessage, sendWithMarkup, answerCallback, editMessageWithMarkup]) f.mockClear();
});
afterEach(() => restorePrisma());

const dm = (text: string, chat: string, reply?: string) => ({ text, chat: { id: chat, type: "private" }, ...(reply ? { reply_to_message: { text: reply } } : {}) });

describe("чат: слова и кнопки", () => {
  it("«не присылай мне оплаты» — вид выключается для владельца, Ширин он продолжает идти", async () => {
    expect(await handleOwnerWords(dm("не присылай мне оплаты", DALER), "tok", DALER)).toBe(true);
    expect(await chatsForKind("payment")).toEqual([SHIRIN]);
  });

  it("«не присылай такое» реплаем на сообщение про оплату — выключает оплаты без вопросов", async () => {
    await handleOwnerWords(dm("не присылай такое", DALER, "💰 Оплата: @x — 21 рецепт, 70 сомони"), "tok", DALER);
    expect(await chatsForKind("payment")).toEqual([SHIRIN]);
    expect(sendWithMarkup).not.toHaveBeenCalled();
  });

  it("«не присылай такое» без контекста — переспрашивает кнопками, ничего не выключает", async () => {
    await handleOwnerWords(dm("не присылай такое", DALER), "tok", DALER);
    expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3])).toContain("nf:off:payment");
    expect((await chatsForKind("payment")).sort()).toEqual([DALER, SHIRIN].sort());
  });

  it("«выключи бота» — переспрашивает, что именно, и сразу ничего не выключает", async () => {
    await handleOwnerWords(dm("выключи бота", DALER), "tok", DALER);
    expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3])).toContain("ct:all:0");
    expect(settings.aiEnabled).toBeUndefined();
  });

  it("«выключи ии» выключает ответы людям; Ширин так сделать не может", async () => {
    await handleOwnerWords(dm("выключи ии", SHIRIN), "tok", SHIRIN);
    expect(settings.aiEnabled).toBeUndefined();
    expect(String(sendTelegramMessage.mock.calls[0]?.[2])).toContain("только владелец");
    await handleOwnerWords(dm("выключи ии", DALER), "tok", DALER);
    expect(settings.aiEnabled).toBe("false");
  });

  it("«включи бота» / «включи ии» / «сними паузу» ничего не включают, а спрашивают кнопкой «Да, включить»", async () => {
    settings.aiEnabled = "false";
    settings.botFrozen = "true";
    for (const t of ["включи бота", "включи ии", "сними паузу"]) {
      sendWithMarkup.mockClear();
      expect(await handleOwnerWords(dm(t, DALER), "tok", DALER)).toBe(true);
      expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3]), t).toContain("Да, включить");
    }
    expect(settings.aiEnabled).toBe("false");
    expect(settings.botFrozen).toBe("true");
  });

  it("пересланное сообщение не разбирается как команда («не пиши клиентам» из чужого текста)", async () => {
    const fwd = { ...dm("не присылай мне оплаты", DALER), forward_origin: { type: "user" }, forward_date: 1_800_000_000 };
    expect(await handleOwnerWords(fwd, "tok", DALER)).toBe(false);
    expect((await chatsForKind("payment")).sort()).toEqual([DALER, SHIRIN].sort());
    for (const extra of [{ forward_from: { id: 1 } }, { forward_sender_name: "Скрыто" }, { forward_date: 1 }]) {
      expect(await handleOwnerWords({ ...dm("выключи бота", DALER), ...extra }, "tok", DALER)).toBe(false);
    }
  });

  it("ответ реплаем на чужое сообщение (вопрос ученицы) — не команда", async () => {
    expect(await handleOwnerWords(dm("выключи бота", DALER, "Можно молоко?"), "tok", DALER)).toBe(false);
  });

  it("кнопка «Выключить бота совсем»: ответы выключены, пауза включена, воронки на паузе", async () => {
    db.model("funnel").findMany.mockResolvedValue([{ id: "f1" }]);
    db.model("funnel").updateMany.mockResolvedValue({ count: 1 });
    await handleControlCallback("tok", { id: "q1", data: "ct:all:0", message: { message_id: 5, chat: { id: Number(DALER) } } });
    expect(settings.aiEnabled).toBe("false");
    expect(settings.botFrozen).toBe("true");
    expect(JSON.parse(settings.funnelsPausedIds)).toEqual(["f1"]);
    expect(db.model("funnel").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled: false } }));
  });

  it("Ширин нажимает кнопку управления — отказ, настройки не тронуты", async () => {
    await handleControlCallback("tok", { id: "q1", data: "ct:ai:0", message: { message_id: 5, chat: { id: Number(SHIRIN) } } });
    expect(settings.aiEnabled).toBeUndefined();
    expect(String(answerCallback.mock.calls[0]?.[2])).toContain("только владелец");
  });

  it("кнопка «🔕 Не присылать такое» под сообщением выключает вид нажавшему", async () => {
    await handleControlCallback("tok", { id: "q1", data: "nf:off:day", message: { message_id: 5, chat: { id: Number(SHIRIN) } } });
    expect(await chatsForKind("day")).toEqual([DALER]);
  });

  it("Ширин не может выключить служебный вид и включить Ширин за владельца", async () => {
    await handleControlCallback("tok", { id: "q1", data: "nf:sh", message: { message_id: 5, chat: { id: Number(SHIRIN) } } });
    expect(settings.notifyShirinEnabled).toBeUndefined();
  });
});
