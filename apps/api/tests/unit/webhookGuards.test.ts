import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const answerFromOwner = vi.fn(async () => true);
const handleQaGroupMessage = vi.fn(async () => undefined);
const handleManualLinkCommand = vi.fn(async () => false);
const handleChatMember = vi.fn(async () => undefined);

vi.mock("../../src/course/chat.js", () => ({ answerFromOwner: (...a: unknown[]) => answerFromOwner(...a) }));
vi.mock("../../src/qaGroup.js", () => ({ handleQaGroupMessage: (...a: unknown[]) => handleQaGroupMessage(...a) }));
vi.mock("../../src/course/manualLink.js", () => ({
  handleManualLinkCommand: (...a: unknown[]) => handleManualLinkCommand(...a),
}));
vi.mock("../../src/groupAccess.js", () => ({ handleChatMember: (...a: unknown[]) => handleChatMember(...a) }));

import { handleTelegramUpdate } from "../../src/telegramWebhook.js";

let db: PrismaMock;
let settings: Record<string, string>;

/** Поддельное «сообщение от Ширин» — ровно то, чем пользовался бы злоумышленник. */
function forged(chatId: string | number) {
  return {
    message: {
      message_id: 42,
      text: "Температуру поднимите до 200 градусов",
      chat: { id: chatId },
      from: { id: chatId },
      reply_to_message: { message_id: 7 },
    },
  };
}

beforeEach(() => {
  db = mockPrisma();
  settings = { telegramQaGroupId: "-100500", telegramReportChatId: "777" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] ? { key: where.key, value: settings[where.key] } : null
  );
  answerFromOwner.mockClear();
  handleQaGroupMessage.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Разбор безопасности 03.09.2026: адрес вебхука открыт всему интернету, секрет
 * заголовка настроить было физически нельзя (ключа не было в списке настроек),
 * а ветка обычных сообщений не смотрела на отправителя вовсе. Кто угодно мог
 * записать ученице выдуманный «ответ учительницы», а при включённом автоответе
 * разослать выдумку дальше.
 */
describe("Вебхук Telegram: чужой чат дальше не пускаем", () => {
  it("ГЛАВНОЕ: поддельное сообщение из постороннего чата не доходит ни до кого", async () => {
    await handleTelegramUpdate(forged(999), undefined);

    expect(answerFromOwner).not.toHaveBeenCalled();
    expect(handleQaGroupMessage).not.toHaveBeenCalled();
  });

  it("сообщение из нашей учебной группы обрабатывается как прежде", async () => {
    answerFromOwner.mockResolvedValue(false); // не ответ ученице — значит в архив группы
    await handleTelegramUpdate(forged("-100500"), undefined);

    expect(handleQaGroupMessage).toHaveBeenCalled();
  });

  it("сообщение из чата сводок тоже своё — там живёт владелица", async () => {
    answerFromOwner.mockResolvedValue(true);
    await handleTelegramUpdate(forged("777"), undefined);

    expect(answerFromOwner).toHaveBeenCalledWith(7, "Температуру поднимите до 200 градусов");
  });

  it("НИ ОДИН чат не настроен — не пускаем никого, а не всех подряд", async () => {
    settings = {};
    await handleTelegramUpdate(forged("-100500"), undefined);

    expect(answerFromOwner).not.toHaveBeenCalled();
    expect(handleQaGroupMessage).not.toHaveBeenCalled();
  });

  it("секрет задан, а заголовок не тот — отказ даже из своего чата", async () => {
    settings.telegramWebhookSecret = "правильный";
    await handleTelegramUpdate(forged("-100500"), "поддельный");

    expect(handleQaGroupMessage).not.toHaveBeenCalled();
  });

  it("секрет задан и совпал — работаем", async () => {
    settings.telegramWebhookSecret = "правильный";
    answerFromOwner.mockResolvedValue(false);
    await handleTelegramUpdate(forged("-100500"), "правильный");

    expect(handleQaGroupMessage).toHaveBeenCalled();
  });
});
