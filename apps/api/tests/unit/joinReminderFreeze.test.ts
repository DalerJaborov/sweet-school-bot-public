import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const { createOneTimeInviteLink, sendTelegramMessage, sendToContact } = vi.hoisted(() => ({
  createOneTimeInviteLink: vi.fn(), sendTelegramMessage: vi.fn(), sendToContact: vi.fn(),
}));
vi.mock("../../src/telegram.js", () => ({
  createOneTimeInviteLink, sendTelegramMessage,
  techChatIds: async () => ["owner"],
}));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact }));
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";
import { runJoinReminders } from "../../src/joinReminder.js";

let db: PrismaMock;
let frozen = false;
let mode = "web";
let freezeOnTelegramChat = false;
/** Ширин когда-то писала клиентке сама (messaging/automation.ts::everTalkedWithShirin). */
let shirinTalked = false;
beforeEach(() => {
  sendToContact.mockReset().mockResolvedValue("mid");
  sendTelegramMessage.mockReset().mockResolvedValue(1);
  frozen = false;
  mode = "web";
  freezeOnTelegramChat = false;
  db = mockPrisma();
  db.model("contact").findUnique.mockResolvedValue({ id: "contact-1", accessTokenId: null, accessIssuedAt: null });
  db.model("contact").updateMany.mockResolvedValue({ count: 1 });
  db.model("setting").findUnique.mockImplementation(async (args) => {
    const key = (args as { where: { key: string } }).where.key;
    if (key === "telegramChatId70" && freezeOnTelegramChat) frozen = true;
    const values: Record<string, string> = {
      botFrozen: String(frozen), courseDeliveryMode: mode,
      telegramBotToken: "token", telegramChatId70: "course-group",
    };
    return values[key] == null ? null : { value: values[key] };
  });
  db.model("contact").findMany.mockResolvedValue([fakeContact({ channel: "WEB" })]);
  db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(), text: "Хочу курс" });
  shirinTalked = false;
  db.model("purchase").findMany.mockResolvedValue([{ id: "paid-course", course: "COURSE70" }]);
});
afterEach(restorePrisma);

/** Сообщение Ширин (byHuman) ищется тем же findFirst, что и последнее входящее: отвечаем по запросу. */
function humanAware(): void {
  const base = db.model("message").findFirst;
  const fallback = base.getMockImplementation();
  base.mockImplementation(async (args: unknown) => {
    if ((args as { where?: { byHuman?: boolean } })?.where?.byHuman) return shirinTalked ? { id: "human" } : null;
    return fallback ? fallback(args) : undefined;
  });
}

describe("in-flight join reminder freeze", () => {
  it("closed Meta window never rotates links and owner sees the actual reason", async () => {
    db.model("contact").findMany.mockResolvedValue([fakeContact()]);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 30 * 3600000), text: "курс" });
    humanAware();
    await runJoinReminders();
    expect(db.model("purchase").findMany).not.toHaveBeenCalled();
    expect(db.model("contact").update.mock.calls.some(([arg]) => "accessTokenId" in (arg as { data: object }).data)).toBe(false);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("окно Instagram закрыто");
    expect(String(sendTelegramMessage.mock.calls[0][2])).not.toContain("перевыпущена");
  });

  it("failed delivery cannot be reported as successful; unnotified work remains retryable", async () => {
    sendToContact.mockRejectedValueOnce(new Error("network error"));
    sendTelegramMessage.mockRejectedValueOnce(new Error("owner unavailable"));
    humanAware();
    await runJoinReminders();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("НЕ доставлено");
    expect(db.model("contact").update.mock.calls.some(([arg]) => "joinReminderAt" in (arg as { data: object }).data)).toBe(false);
    expect(db.model("purchase").delete).not.toHaveBeenCalled();
  });

  it("ambiguous send stops automatic replay even when owner notification fails", async () => {
    sendToContact.mockRejectedValueOnce(new MetaDeliveryError("AMBIGUOUS", 0));
    sendTelegramMessage.mockRejectedValueOnce(new Error("owner unavailable"));
    humanAware();
    await runJoinReminders();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Доставка ссылки или напоминания неизвестна");
    expect(db.model("contact").update.mock.calls.some(([arg]) => "joinReminderAt" in (arg as { data: object }).data)).toBe(true);
    expect(db.model("purchase").update).not.toHaveBeenCalled();
  });

  it("an uncertain access delivery is never retried by the reminder worker", async () => {
    db.model("purchase").count.mockImplementation(async (args: any) => args.where.accessDeliveryUncertainAt ? 1 : 0);
    humanAware();
    await runJoinReminders();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("purchase").findMany).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Доставка ссылки или напоминания неизвестна");
  });

  it("freeze during purchase lookup prevents rotating a paid student's web link", async () => {
    db.model("purchase").findMany.mockImplementation(async () => {
      frozen = true;
      return [{ id: "paid-course", course: "COURSE70" }];
    });
    humanAware();
    await expect(runJoinReminders()).rejects.toThrow("Bot automation is frozen");
    const updates = db.model("contact").update.mock.calls as { data: Record<string, unknown> }[][];
    expect(updates.every(([arg]) => !("accessTokenId" in arg.data))).toBe(true);
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("freeze during Telegram chat lookup prevents minting or sending an invite", async () => {
    mode = "telegram";
    freezeOnTelegramChat = true;
    db.model("contact").findMany.mockResolvedValue([fakeContact()]);
    humanAware();
    await runJoinReminders();
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(db.model("message").create).not.toHaveBeenCalled();
  });
});

describe("Ширин переписывалась с клиенткой сама (владелец 09.11.2026)", () => {
  it("ГЛАВНОЕ: клиентке не напоминаем никогда, ссылки не перевыпускаем; владелец узнаёт", async () => {
    shirinTalked = true;
    humanAware();
    await runJoinReminders();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("purchase").findMany).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Ширин переписывалась с ней сама");
    expect(db.model("contact").update.mock.calls.some(([arg]) => "joinReminderAt" in (arg as { data: object }).data)).toBe(true);
  });

  it("отметка паузы стояла когда-то давно — тоже не напоминаем", async () => {
    db.model("contact").findMany.mockResolvedValue([fakeContact({ channel: "WEB", humanTakenOverAt: new Date(Date.now() - 30 * 86_400_000) })]);
    humanAware();
    await runJoinReminders();
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

