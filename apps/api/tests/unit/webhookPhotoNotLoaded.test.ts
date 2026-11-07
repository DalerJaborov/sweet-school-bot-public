import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Живой случай 05.09.2026 (@lazina_0101): прислала фото (похоже, скриншот
 * оплаты), скачать не вышло — и разговор продолжился так, будто ничего не
 * было: свободная модель сама сказала «Кабул кардем, хозир дохил мекнем»,
 * хотя ни чек, ни доступ никто не проверял и не выдавал. Теперь такой ход до
 * модели не доходит вовсе — отвечаем сами и честно, тем же приёмом, что и
 * ai/receiptClaim.ts для «отправила чек» без вложения.
 */
const sendToContact = vi.fn(async () => "mid-out-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => fakeContact()),
  handleIncomingDm: vi.fn(async () => false),
  handleComment: vi.fn(),
}));
const aiReply = vi.fn(async () => undefined);
const rescueIncomingImages = vi.fn(async () => []);
const registerOfflineIfAsked = vi.fn(async () => false);
vi.mock("../../src/ai.js", () => ({
  aiReply: (...a: unknown[]) => aiReply(...a),
  registerOfflineIfAsked: (...a: unknown[]) => registerOfflineIfAsked(...a),
  rescueIncomingImages: (...a: unknown[]) => rescueIncomingImages(...a),
}));
const debounceMessage = vi.fn();
vi.mock("../../src/debounce.js", () => ({ debounceMessage: (...a: unknown[]) => debounceMessage(...a) }));
vi.mock("../../src/ai/personalContact.js", () => ({ looksPersonal: () => false }));
vi.mock("../../src/ai/abuseFilter.js", () => ({ detectAbuse: () => null }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));
vi.mock("../../src/ownMedia.js", () => ({ findOwnMedia: vi.fn(async () => null), viewableUrl: vi.fn() }));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn(async () => null) }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));

import { voiceToText } from "../../src/ai/voiceToText.js";
import { handleMessage, type MessagingEvent } from "../../src/webhook.js";

let db: PrismaMock;
const photoEvent: MessagingEvent = {
  sender: { id: "ig-lazina" },
  recipient: { id: "page-1" },
  message: { mid: "mid-1", attachments: [{ type: "image", payload: { url: "https://cdn.example/photo.jpg" } }] },
};

beforeEach(() => {
  db = mockPrisma();
  db.model("contact").findUnique.mockResolvedValue({ ...fakeContact(), humanSilencedUntil: null });
  db.model("message").create.mockResolvedValue({});
  db.model("message").findFirst.mockResolvedValue({ text: "Ба ман курси онлайни 70 сомона лозим" });
  sendToContact.mockClear();
  aiReply.mockClear();
  debounceMessage.mockClear();
  rescueIncomingImages.mockClear();
  registerOfflineIfAsked.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Фото пришло, но не скачалось — честный ответ, а не молчаливая потеря", () => {
  it("frozen: preserves funnel routing without receipt intake, signup or AI", async () => {
    db.model("setting").findUnique.mockImplementation(async (args) => {
      const key = (args as { where: { key: string } }).where.key;
      return key === "botFrozen" ? { value: "true" } : null;
    });
    await handleMessage({ ...photoEvent, message: { ...photoEvent.message, text: "Вот чек, хочу офлайн 900123456" } });
    const { handleIncomingDm } = await import("../../src/funnel.js");
    expect(handleIncomingDm).toHaveBeenCalled();
    expect(registerOfflineIfAsked).not.toHaveBeenCalled();
    expect(rescueIncomingImages).not.toHaveBeenCalled();
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });
  it("ГЛАВНОЕ: только картинка, без текста, rescue вернул пусто — просим прислать ещё раз и НЕ зовём модель", async () => {
    rescueIncomingImages.mockResolvedValue([]);
    await handleMessage(photoEvent);

    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toContain("расм бор нашуд");
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("ответ на языке последнего сообщения клиентки (таджикский)", async () => {
    rescueIncomingImages.mockResolvedValue([]);
    await handleMessage(photoEvent);
    expect(String(sendToContact.mock.calls[0][1])).toContain("расм бор нашуд");
  });

  it("картинка спаслась — обычный путь, без специального ответа", async () => {
    rescueIncomingImages.mockResolvedValue([{ buffer: Buffer.from("x"), mimeType: "image/jpeg", hash: "h", url: "/media/x.jpg", queuedId: "q1" }]);
    await handleMessage(photoEvent);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(debounceMessage).toHaveBeenCalledTimes(1);
  });

  it("с текстом рядом с несохранённой картинкой — обычный путь идёт дальше (есть о чём ответить)", async () => {
    rescueIncomingImages.mockResolvedValue([]);
    await handleMessage({ ...photoEvent, message: { ...photoEvent.message, text: "Вот чек" } });
    expect(sendToContact).not.toHaveBeenCalled();
    expect(debounceMessage).toHaveBeenCalledTimes(1);
  });
});


describe("incoming message claim", () => {
  const voice: MessagingEvent = { sender: { id: "customer" }, message: { mid: "voice-mid", attachments: [{ type: "audio", payload: { url: "https://example.invalid/voice" } }] } };
  it("does not transcribe a duplicate delivery", async () => {
    db.model("message").create.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }));
    await handleMessage(voice);
    expect(voiceToText).not.toHaveBeenCalled();
  });
  it("propagates database outages instead of silently treating them as duplicates", async () => {
    db.model("message").create.mockRejectedValue(new Error("SQLITE_BUSY"));
    await expect(handleMessage(voice)).rejects.toThrow("SQLITE_BUSY");
    expect(voiceToText).not.toHaveBeenCalled();
  });
  it("replays AI work after a crash/error following the successful Message insert", async () => {
    const incoming: MessagingEvent = { sender: { id: "customer" }, message: { mid: "persisted-before-crash", text: "Какие курсы есть?" } };
    debounceMessage.mockImplementation(async (_id, text, attachments, rescued, flush) => flush(text, attachments, rescued));
    aiReply.mockRejectedValueOnce(new Error("failure after Message commit")).mockResolvedValue(undefined);
    await expect(handleMessage(incoming, undefined, "INSTAGRAM", true)).rejects.toThrow("failure after Message commit");
    db.model("message").create.mockRejectedValue(Object.assign(new Error("already persisted"), { code: "P2002" }));
    await handleMessage(incoming, undefined, "INSTAGRAM", true);
    expect(aiReply).toHaveBeenCalledTimes(2);
    expect(aiReply).toHaveBeenLastCalledWith(expect.objectContaining({ id: "contact-1" }), "Какие курсы есть?", [], []);
    debounceMessage.mockReset();
  });
  it("can resume an accepted event with an already persisted incoming message", async () => {
    db.model("message").create.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }));
    await handleMessage(voice, undefined, "INSTAGRAM", true);
    expect(voiceToText).toHaveBeenCalledTimes(1);
  });
});
