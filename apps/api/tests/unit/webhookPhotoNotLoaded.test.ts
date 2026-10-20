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
vi.mock("../../src/ai.js", () => ({
  aiReply: (...a: unknown[]) => aiReply(...a),
  registerOfflineIfAsked: vi.fn(async () => false),
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
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Фото пришло, но не скачалось — честный ответ, а не молчаливая потеря", () => {
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
