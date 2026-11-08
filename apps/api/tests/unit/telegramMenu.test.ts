import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => 1);
const sendWithMarkup = vi.fn(async () => true);
const answerCallback = vi.fn(async () => undefined);
const createOneTimeInviteLink = vi.fn(async () => "https://t.me/+abc");
vi.mock("../../src/telegram.js", () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  sendWithMarkup: (...a: unknown[]) => sendWithMarkup(...a),
  answerCallback: (...a: unknown[]) => answerCallback(...a),
  createOneTimeInviteLink: (...a: unknown[]) => createOneTimeInviteLink(...a),
  trustedChatIds: vi.fn(async () => ["111", "222"]),
}));
vi.mock("../../src/dailyReport.js", () => ({
  buildReport: vi.fn(async () => "ОТЧЁТ"),
  offsetMs: vi.fn(async () => 0),
  truncate: (t: string) => t,
}));

import { handleMenuCommand, handleMenuCallback } from "../../src/telegramMenu.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { telegramBotToken: "tok", telegramChatId50: "-100", manualInviteLinks: "old" };
const msg = (text: string, chat = 111, type = "private") => ({ message_id: 1, text, chat: { id: chat, type }, from: { id: chat } });

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("setting").upsert.mockResolvedValue({});
  db.model("receiptCheck").findMany.mockResolvedValue([]);
  db.model("receiptCheck").count.mockResolvedValue(0);
  db.model("courseChatMessage").findMany.mockResolvedValue([]);
  db.model("courseChatMessage").count.mockResolvedValue(0);
  for (const f of [sendTelegramMessage, sendWithMarkup, answerCallback, createOneTimeInviteLink]) f.mockClear();
});
afterEach(() => restorePrisma());

describe("Меню быстрых действий", () => {
  it("/start показывает постоянные кнопки", async () => {
    expect(await handleMenuCommand(msg("/start"))).toBe(true);
    expect(sendWithMarkup).toHaveBeenCalledOnce();
  });
  it("чужой чат и группа: не обрабатываем, ничего не шлём", async () => {
    expect(await handleMenuCommand(msg("📊 Сводка сейчас", 999))).toBe(false);
    expect(await handleMenuCommand(msg("📊 Сводка сейчас", 111, "supergroup"))).toBe(false);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
  it("обычный текст — не наша команда", async () => {
    expect(await handleMenuCommand(msg("привет"))).toBe(false);
  });
  it("«Сводка сейчас» шлёт отчёт тому, кто спросил (сестре тоже)", async () => {
    expect(await handleMenuCommand(msg("📊 Сводка сейчас", 222))).toBe(true);
    expect(sendTelegramMessage.mock.calls[0]?.[1]).toBe("222");
    expect(sendTelegramMessage.mock.calls[0]?.[2]).toBe("ОТЧЁТ");
  });
  it("«Кто ждёт» при пустой очереди отвечает коротко", async () => {
    await handleMenuCommand(msg("⏳ Кто ждёт ответа"));
    expect(sendTelegramMessage.mock.calls[0]?.[2]).toContain("Никто не ждёт");
  });
  it("«Приглашение» предлагает только группы с заданным ID", async () => {
    await handleMenuCommand(msg("👥 Приглашение в группу"));
    const markup = sendWithMarkup.mock.calls[0]?.[3] as { inline_keyboard: { callback_data: string }[][] };
    expect(markup.inline_keyboard.map((r) => r[0].callback_data)).toEqual(["mn:inv:50"]);
  });
  it("кнопка группы: одноразовая ссылка выдана и записана в список ручных", async () => {
    await handleMenuCallback("tok", { id: "cb", data: "mn:inv:50", message: { chat: { id: 111 } } });
    expect(createOneTimeInviteLink).toHaveBeenCalledWith("tok", "-100");
    expect(sendTelegramMessage.mock.calls[0]?.[2]).toContain("https://t.me/+abc");
    expect(JSON.stringify(db.model("setting").upsert.mock.calls)).toContain("old\\nhttps://t.me/+abc");
  });
  it("незаданная группа и мусорный callback ничего не выдают", async () => {
    await handleMenuCallback("tok", { id: "cb", data: "mn:inv:70", message: { chat: { id: 111 } } });
    await handleMenuCallback("tok", { id: "cb", data: "mn:inv:../../x", message: { chat: { id: 111 } } });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });
});
