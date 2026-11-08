import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {}, getSetting: vi.fn(async () => null), logError: vi.fn(), recordOutgoingMessage: vi.fn() }));
vi.mock("../../src/messaging/send.js", () => ({ sendAttachmentToContact: vi.fn() }));
vi.mock("../../src/ai/voiceClone.js", () => ({ synthesizeToFile: vi.fn(), voiceEnabled: vi.fn(async () => false) }));

import { chooseVoiceOrText, trySendVoiceReply } from "../../src/ai/voiceReply.js";

const ctx = { channel: "WHATSAPP", clientSentVoice: false, lastReplyWasVoice: false };

describe("chooseVoiceOrText", () => {
  it("короткий тёплый ответ — голосом", () => {
    expect(chooseVoiceOrText("Здравствуйте! Рада вас видеть, чем помочь?", ctx)).toBe("voice");
  });
  it("ссылки, суммы, реквизиты, списки и длинное — текстом", () => {
    expect(chooseVoiceOrText("Запись тут: https://shirinsweets.online", ctx)).toBe("text");
    expect(chooseVoiceOrText("Курс стоит 500 сомони", ctx)).toBe("text");
    expect(chooseVoiceOrText("Переведите на карту, пожалуйста", ctx)).toBe("text");
    expect(chooseVoiceOrText("Раз\nДва", ctx)).toBe("text");
    expect(chooseVoiceOrText("а".repeat(200), ctx)).toBe("text");
  });
  it("после голосового клиента порог длины мягче", () => {
    const mid = "Конечно, с удовольствием расскажу про курс: в нём много практики, вы будете готовить вместе с нами, а если что-то не получится, мы всегда поможем советом и поддержкой в чате.";
    expect(chooseVoiceOrText(mid, ctx)).toBe("text");
    expect(chooseVoiceOrText(mid, { ...ctx, clientSentVoice: true })).toBe("voice");
  });
  it("не больше одного голосового подряд и только WhatsApp", () => {
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, lastReplyWasVoice: true })).toBe("text");
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, channel: "INSTAGRAM" })).toBe("text");
  });
});

describe("trySendVoiceReply", () => {
  it("рубильник выключен по умолчанию — голосом не отвечает", async () => {
    expect(await trySendVoiceReply({ id: "c", igUserId: "x", channel: "WHATSAPP" }, "Здравствуйте!", true)).toBe(false);
  });
});
