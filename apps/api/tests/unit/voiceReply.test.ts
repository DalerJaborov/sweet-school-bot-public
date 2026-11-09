import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {}, getSetting: vi.fn(async () => null), logError: vi.fn(), recordOutgoingMessage: vi.fn() }));
vi.mock("../../src/messaging/send.js", () => ({ sendAttachmentToContact: vi.fn() }));
vi.mock("../../src/ai/voiceClone.js", () => ({ synthesizeToFile: vi.fn(), voiceEnabled: vi.fn(async () => false) }));

import { chooseVoiceOrText, planVoice, trySendVoiceReply } from "../../src/ai/voiceReply.js";

const ctx = { channel: "WHATSAPP", clientSentVoice: false, lastReplyWasVoice: false };

describe("chooseVoiceOrText", () => {
  it("короткий тёплый ответ — голосом", () => {
    expect(chooseVoiceOrText("Здравствуйте! Рада вас видеть, чем помочь", ctx)).toBe("voice");
  });
  it("ссылки, суммы, реквизиты, списки и длинное — текстом", () => {
    expect(chooseVoiceOrText("Запись тут: https://shirinsweets.online", ctx)).toBe("text");
    expect(chooseVoiceOrText("Курс стоит 500 сомони", ctx)).toBe("text");
    expect(chooseVoiceOrText("Переведите на карту, пожалуйста", ctx)).toBe("text");
    expect(chooseVoiceOrText(["Раз", "Два"].join(String.fromCharCode(10)), ctx)).toBe("voice"); // перенос строки голосу не мешает
    expect(chooseVoiceOrText("а".repeat(300), ctx)).toBe("text");
  });
  it("после голосового клиента порог длины мягче", () => {
    const mid = "Конечно, с удовольствием расскажу про курс: в нём много практики, вы будете готовить вместе с нами, а если что-то не получится, мы всегда поможем советом и поддержкой в чате, и вы никогда не останетесь одни с вашим вопросом, потому что мы рядом на каждом шаге обучения.";
    expect(chooseVoiceOrText(mid, ctx)).toBe("text");
    expect(chooseVoiceOrText(mid, { ...ctx, clientSentVoice: true })).toBe("voice");
  });
  it("не больше одного голосового подряд и только WhatsApp", () => {
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, lastReplyWasVoice: true })).toBe("text");
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, channel: "WEB" })).toBe("text");
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, channel: "INSTAGRAM" })).toBe("voice");
    expect(chooseVoiceOrText("Здравствуйте!", { ...ctx, channel: "MESSENGER" })).toBe("voice");
  });
});

describe("trySendVoiceReply", () => {
  it("рубильник выключен по умолчанию — голосом не отвечает", async () => {
    expect(await trySendVoiceReply({ id: "c", igUserId: "x", channel: "WHATSAPP" }, "Здравствуйте!", true)).toBeNull();
  });
});

describe("обход правила (ревью)", () => {
  const c = { channel: "WHATSAPP", clientSentVoice: true, lastReplyWasVoice: false };
  it.each([
    "t.me/shirin_sweets", "bit.ly/abc", "shirin.me", "Цену уточню", "Стоимость курса пять тысяч",
    "Пешпардохт ҳазор", "Ба корти ман гузаронед", "Напишите @shirin", "Оплата на карту",
  ])("%s — только текстом", (t) => expect(chooseVoiceOrText(t, c)).toBe("text"));
});

describe("splitForVoice — нарезка на короткие голосовые", () => {
  it("короткая реплика — один кусок, несколько предложений склеиваются до ~280 знаков", async () => {
    const { splitForVoice } = await vi.importActual<typeof import("../../src/ai/voiceClone.js")>("../../src/ai/voiceClone.js");
    expect(splitForVoice("Здравствуйте! Рада вас видеть.")).toEqual(["Здравствуйте! Рада вас видеть."]);
    const long = "Первое предложение довольно длинное, чтобы занять место в куске. ".repeat(6).trim();
    const parts = splitForVoice(long)!;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 280)).toBe(true);
  });
  it("слишком длинный ответ (больше 2 кусков) — null, то есть текстом", async () => {
    const { splitForVoice } = await vi.importActual<typeof import("../../src/ai/voiceClone.js")>("../../src/ai/voiceClone.js");
    expect(splitForVoice("Очень длинное предложение для проверки. ".repeat(40))).toBeNull();
  });
});

describe("planVoice — часть голосом, цифры текстом", () => {
  const c = { channel: "INSTAGRAM", clientSentVoice: true, lastReplyWasVoice: false };
  it("клиент прислал голос: предложения без цифр голосом, с ценой - текстом", () => {
    const plan = planVoice("Рахмат, ки навиштед. Нархи курс 70 сомонӣ. Кадом курс ба шумо маъқул аст?", c)!;
    expect(plan.voice).toContain("Рахмат");
    expect(plan.voice).not.toMatch(/\d|сомонӣ/);
    expect(plan.rest).toContain("70");
  });
  it("клиент писал текстом: ответ с цифрами остаётся целиком текстом", () => {
    expect(planVoice("Нархи курс 70 сомонӣ. Рахмат.", { ...c, clientSentVoice: false })).toBeNull();
  });
  it("весь ответ без цифр - целиком голосом, остатка нет", () => {
    expect(planVoice("Салом, хуш омадед!", c)).toEqual({ voice: "Салом, хуш омадед!", rest: "" });
  });
  it("после прошлого голосового - текст", () => {
    expect(planVoice("Рахмат. Нарх 70.", { ...c, lastReplyWasVoice: true })).toBeNull();
  });
});
