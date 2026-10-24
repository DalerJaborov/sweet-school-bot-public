import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const { createOneTimeInviteLink, sendTelegramMessage } = vi.hoisted(() => ({
  createOneTimeInviteLink: vi.fn(), sendTelegramMessage: vi.fn(),
}));
vi.mock("../../src/telegram.js", () => ({
  createOneTimeInviteLink, sendTelegramMessage,
  ownerAlertChatIds: async () => ["owner"],
}));
import { runJoinReminders } from "../../src/joinReminder.js";

let db: PrismaMock;
let frozen = false;
let mode = "web";
let freezeOnTelegramChat = false;
beforeEach(() => {
  frozen = false;
  mode = "web";
  freezeOnTelegramChat = false;
  db = mockPrisma();
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
  db.model("purchase").findMany.mockResolvedValue([{ id: "paid-course", course: "COURSE70" }]);
});
afterEach(restorePrisma);

describe("in-flight join reminder freeze", () => {
  it("freeze during purchase lookup prevents rotating a paid student's web link", async () => {
    db.model("purchase").findMany.mockImplementation(async () => {
      frozen = true;
      return [{ id: "paid-course", course: "COURSE70" }];
    });
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
    await runJoinReminders();
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(db.model("message").create).not.toHaveBeenCalled();
  });
});
