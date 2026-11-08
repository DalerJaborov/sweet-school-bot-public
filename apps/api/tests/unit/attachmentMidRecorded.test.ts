import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ record: vi.fn(async () => undefined), sendAttachment: vi.fn() }));

vi.mock("../../src/db.js", () => ({
  prisma: { message: { create: vi.fn() } },
  WEB_MID_PREFIX: "web:",
  recordOutgoingMessage: state.record,
  logError: vi.fn(),
  getSetting: vi.fn(async () => null),
}));
vi.mock("../../src/instagram.js", () => ({
  channelOf: () => "INSTAGRAM",
  sendText: vi.fn(),
  sendAttachment: state.sendAttachment,
}));
vi.mock("../../src/greeting.js", () => ({ stripRepeatGreeting: async (_id: string, t: string) => t }));
vi.mock("../../src/voice.js", () => ({ toOwnerVoice: (t: string) => t }));
vi.mock("../../src/ai/replyPolicy.js", () => ({ cleanKeepingWarmTail: (t: string) => t }));
vi.mock("../../src/whatsapp/transport.js", () => ({ sendWhatsAppText: vi.fn(), sendWhatsAppAttachment: vi.fn() }));
vi.mock("../../src/messaging/automation.js", () => ({
  assertMessagingAllowed: vi.fn(async () => undefined),
  withMessagingPermission: (_p: string, fn: () => unknown) => fn(),
  withContactMessaging: (_id: string, _p: string, fn: () => unknown) => fn(),
}));

import { sendAttachmentToContact } from "../../src/messaging/send.js";

const contact = { id: "c1", igUserId: "ig1" } as never;

describe("исходящая картинка записывается, чтобы эхо не сочли ответом хозяйки", () => {
  beforeEach(() => {
    state.record.mockClear();
    state.sendAttachment.mockReset();
  });

  it("после отправки в Instagram mid картинки записывается как исходящее бота", async () => {
    state.sendAttachment.mockResolvedValue("mid-image-1");
    await expect(sendAttachmentToContact(contact, "https://x/img.jpg", "image")).resolves.toBe("mid-image-1");
    expect(state.record).toHaveBeenCalledWith("c1", "", "mid-image-1");
  });

  it("нет mid от Meta — ничего не пишем, сбоя нет", async () => {
    state.sendAttachment.mockResolvedValue(null);
    await sendAttachmentToContact(contact, "https://x/v.mp4", "video");
    expect(state.record).not.toHaveBeenCalled();
  });

  it("сбой записи не ломает отправку", async () => {
    state.sendAttachment.mockResolvedValue("mid-2");
    state.record.mockRejectedValueOnce(new Error("db busy"));
    await expect(sendAttachmentToContact(contact, "https://x/img.jpg", "image")).resolves.toBe("mid-2");
  });
});
