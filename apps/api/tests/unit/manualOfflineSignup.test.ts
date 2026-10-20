import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * «Записи из WhatsApp пересылать боту» — решение владельца 05.09.2026: боту
 * нет доступа к WhatsApp Ширин, поэтому запись переносится командой.
 */
const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["111"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { handleWhatsappSignupCommand } from "../../src/course/manualOfflineSignup.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { telegramBotToken: "бот-токен", telegramOwnerChatId: "111" };

function msg(text: string, chatId: string | number = 111) {
  return { message_id: 7, text, chat: { id: chatId }, from: { id: chatId } };
}
function lastReply(): string {
  const calls = sendTelegramMessage.mock.calls;
  return (calls[calls.length - 1]?.[2] as string) ?? "";
}

const contact = { id: "wa-contact-1", igUserId: "wa:900112233", username: "Мадина" };

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("contact").upsert.mockResolvedValue(contact);
  db.model("offlineSignup").findUnique.mockResolvedValue(null);
  db.model("offlineSignup").create.mockResolvedValue({ id: "signup-1" });
  db.model("offlineSignup").update.mockResolvedValue({});
  sendTelegramMessage.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Запись на офлайн-курс из WhatsApp — команда из Telegram", () => {
  it("не команда — сообщение не трогаем", async () => {
    expect(await handleWhatsappSignupCommand(msg("Салом, как дела?"))).toBe(false);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: имя и телефон из пересланного текста — создаётся WhatsApp-контакт и запись", async () => {
    const handled = await handleWhatsappSignupCommand(msg("/вотсап Мадина, хочу на офлайн, 900 11 22 33"));
    expect(handled).toBe(true);
    const upsertArgs = db.model("contact").upsert.mock.calls[0][0] as {
      where: { channel_igUserId: { channel: string; igUserId: string } };
      create: { username: string | null };
    };
    expect(upsertArgs.where.channel_igUserId).toEqual({ channel: "WHATSAPP", igUserId: "wa:900112233" });
    expect(upsertArgs.create.username).toBe("Мадина");
    expect(db.model("offlineSignup").create).toHaveBeenCalledTimes(1);
    expect(lastReply()).toContain("Мадина");
    expect(lastReply()).toContain("900112233");
  });

  it("без номера телефона — просит попробовать ещё раз, ничего не создаёт", async () => {
    await handleWhatsappSignupCommand(msg("/вотсап Мадина хочет записаться"));
    expect(db.model("contact").upsert).not.toHaveBeenCalled();
    expect(lastReply()).toContain("Не нашла номер");
  });

  it("без аргумента — подсказка формата", async () => {
    await handleWhatsappSignupCommand(msg("/вотсап"));
    expect(lastReply()).toContain("/вотсап Мадина");
  });

  it("повторная запись того же номера — не дублирует, честно говорит", async () => {
    db.model("offlineSignup").findUnique.mockResolvedValue({ id: "signup-1" });
    await handleWhatsappSignupCommand(msg("/вотсап Мадина, 900112233"));
    expect(db.model("offlineSignup").create).not.toHaveBeenCalled();
    expect(lastReply()).toContain("уже есть");
  });

  it("посторонний чат — молчание, ничего не создаётся", async () => {
    const handled = await handleWhatsappSignupCommand(msg("/вотсап Мадина, 900112233", "999"));
    expect(handled).toBe(true);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("contact").upsert).not.toHaveBeenCalled();
  });

  it("алиасы команды тоже работают (/wa, /whatsapp)", async () => {
    await handleWhatsappSignupCommand(msg("/wa Зарина 918112233"));
    expect(db.model("contact").upsert).toHaveBeenCalledTimes(1);
  });
});
