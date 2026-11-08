import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

vi.mock("../../src/course/deliveryChoice.js", () => ({ handleDeliveryChoiceReply: vi.fn(async () => false) }));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "mid-out") }));
const handleIncomingDm = vi.fn(async () => false);
const contactRef: { current: Record<string, unknown> } = { current: {} };
vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => contactRef.current),
  handleIncomingDm: (...a: unknown[]) => (handleIncomingDm as (...x: unknown[]) => unknown)(...a),
  handleComment: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({
  aiReply: vi.fn(async () => undefined),
  registerOfflineIfAsked: vi.fn(async () => false),
  rescueIncomingImages: vi.fn(async () => []),
}));
const debounceMessage = vi.fn();
vi.mock("../../src/debounce.js", () => ({ debounceMessage: (...a: unknown[]) => debounceMessage(...a) }));
vi.mock("../../src/ai/abuseFilter.js", () => ({ detectAbuse: () => null }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));
const findOwnMedia = vi.fn();
vi.mock("../../src/ownMedia.js", () => ({
  findOwnMedia: (...a: unknown[]) => findOwnMedia(...a),
  viewableUrl: vi.fn(() => null),
}));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn(async () => null) }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));

import { handleMessage, type MessagingEvent } from "../../src/webhook.js";

let db: PrismaMock;
const ago = (m: number) => new Date(Date.now() - m * 60_000);
const text = (t: string, extra: Partial<NonNullable<MessagingEvent["message"]>> = {}): MessagingEvent => ({
  sender: { id: "ig-1" },
  recipient: { id: "page-1" },
  message: { mid: "m-" + Math.random(), text: t, ...extra },
});

beforeEach(() => {
  db = mockPrisma();
  contactRef.current = { ...fakeContact(), humanSilencedUntil: null, humanTakenOverAt: null };
  db.model("contact").findUnique.mockImplementation(async () => contactRef.current);
  db.model("message").create.mockResolvedValue({});
  db.model("message").count.mockResolvedValue(5);
  db.model("message").findFirst.mockResolvedValue({ createdAt: ago(1), text: "x" });
  debounceMessage.mockClear();
  handleIncomingDm.mockClear();
  findOwnMedia.mockReset();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("чужие публикации и истории", () => {
  it("чужой рилс: молчим, воронка и ИИ не вызываются", async () => {
    findOwnMedia.mockResolvedValue(null);
    await handleMessage(
      text("", { attachments: [{ type: "reel", payload: { url: "https://instagram.com/reel/AAA/" } }] }),
    );
    expect(handleIncomingDm).not.toHaveBeenCalled();
    expect(debounceMessage).not.toHaveBeenCalled();
  });
  it("наш рилс с вопросом про цену: отвечаем", async () => {
    findOwnMedia.mockResolvedValue({ id: "1", permalink: "", caption: "Курс по десертам", mediaType: "VIDEO" });
    await handleMessage(
      text("сколько стоит?", { attachments: [{ type: "reel", payload: { url: "https://instagram.com/reel/BBB/" } }] }),
    );
    expect(debounceMessage).toHaveBeenCalled();
  });
  it("ответ на нашу историю без слов про курсы: молчим, но переписка сохранена", async () => {
    findOwnMedia.mockResolvedValue({ id: "s1", permalink: "", caption: "Новый торт", mediaType: "IMAGE" });
    await handleMessage(text("красота!", { reply_to: { story: { id: "s1" } } }));
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("message").create).toHaveBeenCalled();
  });
  it("ответ на историю, где в самом ответе вопрос про курс: отвечаем", async () => {
    findOwnMedia.mockResolvedValue({ id: "s1", permalink: "", caption: "Новый торт", mediaType: "IMAGE" });
    await handleMessage(text("а когда следующий курс?", { reply_to: { story: { id: "s1" } } }));
    expect(debounceMessage).toHaveBeenCalled();
  });
  it("история про курсы: отвечаем даже на короткий ответ", async () => {
    findOwnMedia.mockResolvedValue({ id: "s2", permalink: "", caption: "Запись на курс открыта", mediaType: "IMAGE" });
    await handleMessage(text("хочу", { reply_to: { story: { id: "s2" } } }));
    expect(debounceMessage).toHaveBeenCalled();
  });
});

describe("родня по первому сообщению", () => {
  it("«Мама, ты дома?» первым сообщением: личный контакт, бот молчит", async () => {
    db.model("message").count.mockResolvedValue(1);
    await handleMessage(text("Мама, ты дома?"));
    expect(db.model("contact").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ personal: true }) }),
    );
    expect(debounceMessage).not.toHaveBeenCalled();
  });
  it("«моя мама хочет на курс» — клиентка, не родня", async () => {
    db.model("message").count.mockResolvedValue(1);
    await handleMessage(text("моя мама хочет на курс, сколько стоит?"));
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(debounceMessage).toHaveBeenCalled();
  });
});

describe("умный перехват хозяйки в вебхуке", () => {
  it("Ширин писала 2 минуты назад: бот молчит, ответ отложен", async () => {
    contactRef.current.humanTakenOverAt = ago(2);
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(2), text: "x" });
    await handleMessage(text("а адрес какой?"));
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").create).toHaveBeenCalled();
  });
  it("Ширин молчит 40 минут: бот отвечает, перехват снят", async () => {
    contactRef.current.humanTakenOverAt = ago(40);
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(40), text: "x" });
    db.model("contact").updateMany.mockImplementation(async () => {
      contactRef.current.humanTakenOverAt = null;
      return { count: 1 };
    });
    await handleMessage(text("а адрес какой?"));
    expect(debounceMessage).toHaveBeenCalled();
  });
  it("фото без подписи в живом разговоре хозяйки: ответ откладывается, а не теряется", async () => {
    contactRef.current.humanTakenOverAt = ago(2);
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(2), text: "x" });
    await handleMessage(text("", { text: undefined, attachments: [{ type: "image", payload: { url: "https://cdn.example/p.jpg" } }] }));
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ text: expect.stringContaining("фото") }),
    });
  });
  it("«спасибо» во время живого разговора: отвечаем сразу", async () => {
    contactRef.current.humanTakenOverAt = ago(2);
    db.model("message").findFirst.mockResolvedValue({ createdAt: ago(2), text: "x" });
    await handleMessage(text("Рахмат"));
    expect(debounceMessage).toHaveBeenCalled();
  });
});
