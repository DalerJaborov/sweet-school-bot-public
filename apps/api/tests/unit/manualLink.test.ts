import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

const issueCourseLink = vi.fn(async () => "https://sweetbot.royalhome.tj/course.html?token=НОВАЯ");
vi.mock("../../src/course/delivery.js", () => ({
  issueCourseLink: (...a: unknown[]) => issueCourseLink(...a),
}));

import { handleManualLinkCommand } from "../../src/course/manualLink.js";

let db: PrismaMock;

const SETTINGS: Record<string, string> = {
  telegramBotToken: "бот-токен",
  telegramOwnerChatId: "111",
};

/** Сообщение из чата владельца, если не сказано иное. */
function msg(text: string, chatId: string | number = 111) {
  return { message_id: 7, text, chat: { id: chatId }, from: { id: chatId } };
}

/** Что бот ответил последним. */
function lastReply(): string {
  const calls = sendTelegramMessage.mock.calls;
  return (calls[calls.length - 1]?.[2] as string) ?? "";
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("contact").findMany.mockResolvedValue([]);
  db.model("purchase").findMany.mockResolvedValue([]);
  db.model("purchase").count.mockResolvedValue(0);
  sendTelegramMessage.mockClear();
  issueCourseLink.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

const contact = {
  id: "contact-1",
  username: "malika",
  igUserId: "ig-1",
  studentFirstName: "Малика",
  studentLastName: null,
};

describe("Ручная выдача ссылки командой из Telegram", () => {
  it("обычное сообщение не команда — пропускаем дальше", async () => {
    expect(await handleManualLinkCommand(msg("Как дела?"))).toBe(false);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: посторонний чат не получает НИЧЕГО — ни ссылки, ни ответа", async () => {
    // Иначе любой, кто найдёт бота, попросил бы доступ к чужим оплаченным
    // урокам, просто назвав чужой ник.
    db.model("contact").findMany.mockResolvedValue([contact]);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p-1", course: "Торты" }]);

    const handled = await handleManualLinkCommand(msg("/ссылка @malika", 999));

    expect(handled).toBe(true); // съедено, дальше не ведём
    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("чат владельца не настроен — команда мертва для всех", async () => {
    delete SETTINGS.telegramOwnerChatId;
    const handled = await handleManualLinkCommand(msg("/ссылка @malika"));
    SETTINGS.telegramOwnerChatId = "111";

    expect(handled).toBe(false);
    expect(issueCourseLink).not.toHaveBeenCalled();
  });

  it("выдаёт свежую ссылку и предупреждает, что прошлая умерла", async () => {
    db.model("contact").findMany.mockResolvedValue([contact]);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p-1", course: "Торты" }]);

    await handleManualLinkCommand(msg("/ссылка @malika"));

    // Ссылка — на человека: одна на все его курсы.
    expect(issueCourseLink).toHaveBeenCalledWith("contact-1");
    expect(lastReply()).toContain("token=НОВАЯ");
    expect(lastReply()).toContain("@malika");
    expect(lastReply()).toContain("Малика");
    expect(lastReply()).toContain("не работает");
  });

  it("ОТОЗВАННЫЙ доступ не оживает командой — иначе «отобрать» ничего не значит", async () => {
    db.model("contact").findMany.mockResolvedValue([contact]);
    db.model("purchase").findMany.mockResolvedValue([]); // действующих нет
    db.model("purchase").count.mockResolvedValue(1); // но отозванная была

    await handleManualLinkCommand(msg("/ссылка @malika"));

    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(lastReply()).toContain("отобран");
  });

  it("оплаты нет — так и говорим, ссылку не придумываем", async () => {
    db.model("contact").findMany.mockResolvedValue([contact]);

    await handleManualLinkCommand(msg("/ссылка @malika"));

    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(lastReply()).toContain("нет оплаченного курса");
  });

  it("подходят несколько — выбираем не мы: доступ не тому это отданные деньги", async () => {
    db.model("contact").findMany.mockResolvedValue([contact, { ...contact, id: "c-2", username: "malika_cake" }]);

    await handleManualLinkCommand(msg("/ссылка malika"));

    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(lastReply()).toContain("@malika_cake");
  });

  it("никого не нашли — подсказываем, что ник пишется без значка", async () => {
    await handleManualLinkCommand(msg("/ссылка @нет-такой"));
    expect(lastReply()).toContain("Не нашла никого");
  });

  it("команда без ника — короткая подсказка, как звать", async () => {
    await handleManualLinkCommand(msg("/ссылка"));
    expect(lastReply()).toContain("/ссылка @username");
    expect(db.model("contact").findMany).not.toHaveBeenCalled();
  });

  it("зовётся по-английски и таджикской латиницей тоже", async () => {
    for (const cmd of ["/link", "/havola", "/dostup"]) {
      sendTelegramMessage.mockClear();
      expect(await handleManualLinkCommand(msg(cmd))).toBe(true);
      expect(lastReply()).toContain("/ссылка @username");
    }
  });

  it("значок @ перед ником не мешает искать", async () => {
    db.model("contact").findMany.mockResolvedValue([contact]);
    db.model("purchase").findMany.mockResolvedValue([{ id: "p-1", course: "Торты" }]);

    await handleManualLinkCommand(msg("/ссылка @malika"));

    const where = db.model("contact").findMany.mock.calls[0][0] as {
      where: { OR: { username?: { contains: string }; igUserId?: string }[] };
    };
    expect(where.where.OR[0].username?.contains).toBe("malika");
  });
});
