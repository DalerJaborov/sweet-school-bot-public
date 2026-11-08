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
const handleManualLinkCommand = vi.fn(async () => true);
vi.mock("../../src/course/manualLink.js", () => ({
  handleManualLinkCommand: (...a: unknown[]) => handleManualLinkCommand(...a),
}));
const createSiteLink = vi.fn(async (i: { label?: string | null }) => ({ code: "abc234", label: i.label ?? null }));
vi.mock("../../src/links/siteLinks.js", async (orig) => ({
  ...(await orig<typeof import("../../src/links/siteLinks.js")>()),
  createSiteLink: (...a: unknown[]) => createSiteLink(...(a as [{ label?: string | null }])),
  shortUrl: (c: string) => `https://x.test/go/${c}`,
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
  it("«Последние оплаты» считает сумму", async () => {
    db.model("purchase").findMany.mockResolvedValue([
      { course: "COURSE70", amount: 70, contact: { username: "malika", igUserId: "1" } },
      { course: "COURSE50", amount: 50, contact: { username: null, igUserId: "123456789" } },
    ]);
    await handleMenuCommand(msg("💳 Последние оплаты"));
    const t = sendTelegramMessage.mock.calls[0]?.[2] as string;
    expect(t).toContain("120 сомони");
    expect(t).toContain("@malika");
  });
  it("«Найти ученицу» просит ник реплаем, ответ показывает курсы", async () => {
    await handleMenuCommand(msg("🔎 Найти ученицу"));
    const markup = sendWithMarkup.mock.calls[0]?.[3] as { force_reply: boolean };
    expect(markup.force_reply).toBe(true);
    const prompt = sendWithMarkup.mock.calls[0]?.[2] as string;
    db.model("contact").findFirst.mockResolvedValue({ id: "c1", username: "malika", paid: true });
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70", amount: 70, joinedAt: new Date() }]);
    await handleMenuCommand({ ...msg("@Malika"), reply_to_message: { text: prompt } });
    expect(sendTelegramMessage.mock.calls[0]?.[2]).toContain("21 рецепт");
  });
  it("«Выдать доступ»: ответ с ником уходит в команду /ссылка", async () => {
    await handleMenuCommand(msg("🔑 Выдать доступ"));
    const prompt = sendWithMarkup.mock.calls[0]?.[2] as string;
    await handleMenuCommand({ ...msg("@malika"), reply_to_message: { text: prompt } });
    expect((handleManualLinkCommand.mock.calls[0]?.[0] as { text: string }).text).toBe("/ссылка @malika");
  });
  it("ответ на чужое сообщение из чужого чата не работает", async () => {
    expect(await handleMenuCommand({ ...msg("@x", 999), reply_to_message: { text: "Кого найти? Ответьте на это сообщение ником" } })).toBe(false);
  });
  it("«Ссылка на сайт»: три шага и короткая ссылка", async () => {
    await handleMenuCommand(msg("🔗 Ссылка на сайт"));
    expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3])).toContain("mn:lt:online");
    await handleMenuCallback("tok", { id: "c", data: "mn:lt:online", message: { chat: { id: 111 } } });
    await handleMenuCallback("tok", { id: "c", data: "mn:ll:online:tg", message: { chat: { id: 111 } } });
    await handleMenuCallback("tok", { id: "c", data: "mn:ls:online:tg:instagram", message: { chat: { id: 111 } } });
    expect(createSiteLink).toHaveBeenCalledWith({ target: "online", lang: "tg", source: "instagram", label: undefined });
    expect(sendTelegramMessage.mock.calls.at(-1)?.[2]).toContain("https://x.test/go/abc234");
  });
  it("блогер: спрашивает имя, ответ создаёт ссылку с именем", async () => {
    await handleMenuCallback("tok", { id: "c", data: "mn:ls:art:ru:blogger", message: { chat: { id: 111 } } });
    const prompt = sendWithMarkup.mock.calls.at(-1)?.[2] as string;
    await handleMenuCommand({ ...msg("Малика"), reply_to_message: { text: prompt } });
    expect(createSiteLink).toHaveBeenCalledWith({ target: "art", lang: "ru", source: "blogger", label: "Малика" });
  });
  it("мусорный шаг ссылки ничего не создаёт", async () => {
    await handleMenuCallback("tok", { id: "c", data: "mn:ls:evil:tg:ads", message: { chat: { id: 111 } } });
    expect(createSiteLink).not.toHaveBeenCalled();
  });
});
