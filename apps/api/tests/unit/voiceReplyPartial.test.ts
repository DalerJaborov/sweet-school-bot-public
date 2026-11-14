import { describe, it, expect, vi } from "vitest";

const record = vi.fn(async () => {});
const send = vi.fn();
vi.mock("../../src/db.js", () => ({
  prisma: { message: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) } },
  getSetting: vi.fn(async () => "true"),
  logError: vi.fn(),
  recordOutgoingMessage: (...a: unknown[]) => record(...a),
}));
vi.mock("../../src/messaging/send.js", () => ({ sendAttachmentToContact: (...a: unknown[]) => send(...a) }));
vi.mock("../../src/ai/voiceClone.js", () => ({
  voiceEnabled: vi.fn(async () => true),
  splitForVoice: () => ["Салом, рафиқ.", "Хуш омадед."],
  decorateForV3: (c: string) => c,
  synthesizeToFile: vi.fn(async (t: string) => ({ url: `https://x/${t}.ogg`, cached: false })),
}));

import { trySendVoiceReply } from "../../src/ai/voiceReply.js";

const contact = { id: "c1", igUserId: "u", channel: "WHATSAPP" };

describe("частичная отправка голосовых", () => {
  it("второй кусок упал: первый записан в историю, ошибка уходит наружу, текстом не дублируем", async () => {
    send.mockReset().mockResolvedValueOnce("mid-1").mockRejectedValueOnce(new Error("429"));
    record.mockClear();
    await expect(trySendVoiceReply(contact, "Здравствуйте, рада вас видеть", false)).rejects.toThrow("429");
    expect(record).toHaveBeenCalledTimes(1);
    expect(String((record.mock.calls[0] as unknown[])[1])).toContain("ушло 1 из 2");
  });
  it("оба куска ушли: одна запись в историю", async () => {
    send.mockReset().mockResolvedValue("mid");
    record.mockClear();
    expect(await trySendVoiceReply(contact, "Здравствуйте, рада вас видеть", false)).toBe("");
    expect(send).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("Meta отказала в аудио до первой отправки", () => {
  it("чёткий отказ 400 - ответ уходит текстом (false), без исключения", async () => {
    const { MetaDeliveryError } = await import("../../src/messaging/metaErrors.js");
    send.mockReset().mockRejectedValueOnce(new MetaDeliveryError("PERMANENT" as never, 400));
    record.mockClear();
    expect(await trySendVoiceReply({ id: "c1", igUserId: "u", channel: "INSTAGRAM" }, "Здравствуйте, рада вас видеть", false)).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
  it("неопределённый исход - ошибка наружу, текстом не дублируем", async () => {
    const { MetaDeliveryError } = await import("../../src/messaging/metaErrors.js");
    send.mockReset().mockRejectedValueOnce(new MetaDeliveryError("AMBIGUOUS", 0));
    await expect(trySendVoiceReply({ id: "c1", igUserId: "u", channel: "INSTAGRAM" }, "Здравствуйте, рада вас видеть", false)).rejects.toThrow();
  });
});
