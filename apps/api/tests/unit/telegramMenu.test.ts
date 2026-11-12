import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => 1);
const sendWithMarkup = vi.fn(async () => true);
const answerCallback = vi.fn(async () => undefined);
const createOneTimeInviteLink = vi.fn(async () => "https://t.me/+abc");
vi.mock("../../src/telegram.js", async (orig) => ({
  ...(await orig<typeof import("../../src/telegram.js")>()),
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
const ANNA = { id: "c1", handle: "@anna", name: "Анна", courses: ["COURSE50"] };
const BELLA = { id: "c2", handle: "@bella", name: null, courses: ["COURSE70"] };
const findPeople = vi.fn(async (_q: string): Promise<unknown[]> => [ANNA]);
const issueOwnerLink = vi.fn(async (_id: string, _k: string): Promise<unknown> => ({
  ok: true, kind: "web", url: "https://school.test/l/XYZ", courses: ["COURSE50"],
}));
vi.mock("../../src/course/ownerLink.js", async (orig) => ({
  ...(await orig<typeof import("../../src/course/ownerLink.js")>()),
  findPeople: (q: string) => findPeople(q),
  getPerson: async (id: string) => [ANNA, BELLA].find((p) => p.id === id) ?? null,
  issueOwnerLink: (id: string, k: string) => issueOwnerLink(id, k),
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
  for (const f of [sendTelegramMessage, sendWithMarkup, answerCallback, createOneTimeInviteLink, issueOwnerLink, findPeople]) f.mockClear();
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
  it("«Выдать доступ»: ник → выбор «В Telegram» / «На сайт» → ссылка с кнопкой «Переслать»", async () => {
    await handleMenuCommand(msg("🔑 Выдать доступ"));
    const prompt = sendWithMarkup.mock.calls[0]?.[2] as string;
    sendWithMarkup.mockClear();
    await handleMenuCommand({ ...msg("anna"), reply_to_message: { text: prompt } });
    expect(findPeople).toHaveBeenCalledWith("anna");
    const kb = JSON.stringify(sendWithMarkup.mock.calls[0]?.[3]);
    expect(kb).toMatch(/mn:ik:[0-9a-f]{12}:t/);
    const web = /mn:ik:[0-9a-f]{12}:w/.exec(kb)![0];
    sendWithMarkup.mockClear();
    await handleMenuCallback("tok", { id: "c", data: web, message: { chat: { id: 111 } } });
    expect(issueOwnerLink).toHaveBeenCalledWith("c1", "web");
    expect(sendWithMarkup.mock.calls[0]?.[2]).toContain("https://school.test/l/XYZ");
    expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3])).toContain("t.me/share/url");
  });
  it("кнопка карточки одноразовая: второе нажатие ничего не выдаёт", async () => {
    await handleMenuCommand({ ...msg("anna"), reply_to_message: { text: "Кому выдать доступ? Ответьте на это сообщение ником или именем" } });
    const tg = /mn:ik:[0-9a-f]{12}:t/.exec(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3]))![0];
    issueOwnerLink.mockClear();
    await handleMenuCallback("tok", { id: "c", data: tg, message: { chat: { id: 111 } } });
    await handleMenuCallback("tok", { id: "c2", data: tg, message: { chat: { id: 111 } } });
    expect(issueOwnerLink).toHaveBeenCalledTimes(1);
    expect(answerCallback.mock.calls.at(-1)?.[2]).toContain("устарела");
  });
  it("кнопка с выдуманной меткой ничего не выдаёт", async () => {
    issueOwnerLink.mockClear();
    await handleMenuCallback("tok", { id: "c", data: "mn:ik:aaaaaaaaaaaa:w", message: { chat: { id: 111 } } });
    expect(issueOwnerLink).not.toHaveBeenCalled();
  });
  it("несколько найденных — список кнопок, выбор открывает карточку канала", async () => {
    findPeople.mockResolvedValueOnce([ANNA, BELLA]);
    await handleMenuCommand({ ...msg("a"), reply_to_message: { text: "Кому выдать доступ? Ответьте на это сообщение ником или именем" } });
    const kb = JSON.stringify(sendWithMarkup.mock.calls[0]?.[3]);
    const pick = /mn:ip:[0-9a-f]{12}/.exec(kb)![0];
    sendWithMarkup.mockClear();
    await handleMenuCallback("tok", { id: "c", data: pick, message: { chat: { id: 111 } } });
    expect(JSON.stringify(sendWithMarkup.mock.calls[0]?.[3])).toMatch(/mn:ik:[0-9a-f]{12}:w/);
  });
  it("никого не нашли — понятный ответ без кнопок", async () => {
    findPeople.mockResolvedValueOnce([]);
    sendWithMarkup.mockClear();
    await handleMenuCommand({ ...msg("zzz"), reply_to_message: { text: "Кому выдать доступ? Ответьте на это сообщение ником или именем" } });
    expect(sendWithMarkup).not.toHaveBeenCalled();
    expect(sendTelegramMessage.mock.calls.at(-1)?.[2]).toContain("Не нашла");
  });
  it("отказ выдачи показывает причину простыми словами", async () => {
    issueOwnerLink.mockResolvedValueOnce({ ok: false, reason: "in-group" });
    await handleMenuCommand({ ...msg("anna"), reply_to_message: { text: "Кому выдать доступ? Ответьте на это сообщение ником или именем" } });
    const tg = /mn:ik:[0-9a-f]{12}:t/.exec(JSON.stringify(sendWithMarkup.mock.calls.at(-1)?.[3]))![0];
    await handleMenuCallback("tok", { id: "c", data: tg, message: { chat: { id: 111 } } });
    expect(sendTelegramMessage.mock.calls.at(-1)?.[2]).toContain("уже в группе");
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

// Владелец 12.11.2026: кнопки должны появиться без «/menu».
describe("pushMenuOnce — кнопки приходят сами", () => {
  it("шлёт клавиатуру в личные чаты владельца и Ширин один раз на версию", async () => {
    const { pushMenuOnce, MENU_PUSHED_SETTING, MENU_VERSION } = await import("../../src/telegramMenu.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const n = await pushMenuOnce("tok", { owner: ["111", "-100500"], shirin: ["222"] });
    expect(n).toBe(2);
    const chats = sendWithMarkup.mock.calls.map((c) => (c as unknown[])[1]);
    expect(chats).toEqual(["111", "222"]); // группа (-100500) пропущена
    const kb = (sendWithMarkup.mock.calls[0] as unknown[])[3] as { keyboard: { text: string }[][] };
    expect(JSON.stringify(kb.keyboard)).toContain("Управление");
    expect(JSON.stringify((sendWithMarkup.mock.calls[1] as unknown[])[3])).not.toContain("Управление");
    expect(db.model("setting").upsert).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("setMyCommands"))).toBe(true);

    SETTINGS[MENU_PUSHED_SETTING] = MENU_VERSION;
    sendWithMarkup.mockClear();
    expect(await pushMenuOnce("tok", { owner: ["111"], shirin: [] })).toBe(0);
    expect(sendWithMarkup).not.toHaveBeenCalled();
    delete SETTINGS[MENU_PUSHED_SETTING];
    fetchSpy.mockRestore();
  });
});
