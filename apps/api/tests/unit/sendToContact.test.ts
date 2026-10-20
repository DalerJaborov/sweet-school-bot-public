import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-meta");
const sendAttachment = vi.fn(async () => "mid-att");

vi.mock("../../src/instagram.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/instagram.js")>();
  return {
    ...actual,
    sendText: (...a: unknown[]) => sendText(...(a as [])),
    sendAttachment: (...a: unknown[]) => sendAttachment(...(a as [])),
  };
});
// Голос и приветствие — чужая логика, здесь важна только маршрутизация.
vi.mock("../../src/greeting.js", () => ({ stripRepeatGreeting: async (_id: string, t: string) => t }));
vi.mock("../../src/voice.js", () => ({ toOwnerVoice: (t: string) => t }));

import { sendToContact, sendImageToContact, sendAttachmentToContact } from "../../src/messaging/send.js";
import { recordOutgoingMessage, WEB_MID_PREFIX } from "../../src/db.js";

type Recipient = { id: string; igUserId: string; channel: string };

describe("sendToContact — маршрутизация по каналу", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    sendText.mockClear().mockResolvedValue("mid-meta");
    sendAttachment.mockClear().mockResolvedValue("mid-att");
  });
  afterEach(restorePrisma);

  it("INSTAGRAM — тот же sendText, с теми же аргументами, базу не трогает", async () => {
    const contact = fakeContact() as Recipient;
    const mid = await sendToContact(contact, "Привет", [{ title: "Да", payload: "YES" }]);
    expect(mid).toBe("mid-meta");
    expect(sendText).toHaveBeenCalledWith("ig-1", "Привет", [{ title: "Да", payload: "YES" }], "INSTAGRAM");
    expect(db.model("message").create).not.toHaveBeenCalled();
  });

  it("MESSENGER — канал прокидывается в sendText", async () => {
    await sendToContact(fakeContact({ channel: "MESSENGER", igUserId: "fb-1" }) as Recipient, "Салом");
    expect(sendText).toHaveBeenCalledWith("fb-1", "Салом", [], "MESSENGER");
  });

  it("WEB — в Meta не ходит, пишет Message(OUT) и отдаёт mid с префиксом", async () => {
    const contact = fakeContact({ channel: "WEB", igUserId: "visitor-1" }) as Recipient;
    const mid = await sendToContact(contact, "Ответ бота");
    expect(sendText).not.toHaveBeenCalled();
    expect(mid?.startsWith(WEB_MID_PREFIX)).toBe(true);
    const created = db.model("message").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({ contactId: "contact-1", direction: "OUT", text: "Ответ бота", byHuman: false, mid });
  });

  it("WEB + byHuman — сайт покажет как ответ владельца", async () => {
    await sendToContact(fakeContact({ channel: "WEB" }) as Recipient, "Это Ширин", [], { byHuman: true });
    const created = db.model("message").create.mock.calls[0][0] as { data: { byHuman: boolean } };
    expect(created.data.byHuman).toBe(true);
  });

  it("recordOutgoingMessage не дублирует строку по web-mid", async () => {
    await recordOutgoingMessage("contact-1", "текст", `${WEB_MID_PREFIX}abc`);
    expect(db.model("message").create).not.toHaveBeenCalled();
    await recordOutgoingMessage("contact-1", "текст", "meta-mid");
    expect(db.model("message").create).toHaveBeenCalledTimes(1);
  });

  it("картинка: Meta — sendAttachment, WEB — строка с imageUrl", async () => {
    await sendImageToContact(fakeContact() as Recipient, "https://x/1.jpg");
    expect(sendAttachment).toHaveBeenCalledWith("ig-1", "https://x/1.jpg", "image", "INSTAGRAM");

    await sendAttachmentToContact(fakeContact({ channel: "WEB" }) as Recipient, "https://x/2.jpg", "image");
    const created = db.model("message").create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({ direction: "OUT", imageUrl: "https://x/2.jpg", text: null });

    // Видео на сайте — ссылкой текстом: плеера в ленте чата нет.
    await sendAttachmentToContact(fakeContact({ channel: "WEB" }) as Recipient, "https://x/v.mp4", "video");
    const video = db.model("message").create.mock.calls[1][0] as { data: Record<string, unknown> };
    expect(video.data).toMatchObject({ text: "https://x/v.mp4", imageUrl: null });
  });
});
