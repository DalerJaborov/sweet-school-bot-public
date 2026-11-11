import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
import type { Contact } from "@prisma/client";

vi.mock("../../src/instagram.js", () => ({
  sendText: vi.fn(async () => "mid-out"),
  sendAttachment: vi.fn(async () => "mid-att"),
  channelOf: () => "INSTAGRAM",
}));

import { sendToContact, sendAttachmentToContact, mediaAlreadySent } from "../../src/messaging/send.js";
import { sendText } from "../../src/instagram.js";
import { rememberDeliveryPreference } from "../../src/course/deliveryChoice.js";
import { deliveryPrompt } from "../../src/ai/deliveryContext.js";

let db: PrismaMock;
beforeEach(() => {
  vi.clearAllMocks();
  db = mockPrisma();
  db.model("contact").findUnique.mockResolvedValue(fakeContact());
  db.model("setting").findUnique.mockResolvedValue(null);
});
afterEach(() => restorePrisma());

describe("п.2 одно приветствие — и в истории то, что ушло", () => {
  it("уже здоровались: «Ассалому алейкум» снят и у клиента, и в записи истории", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date() });
    db.model("message").findMany.mockResolvedValue([{ text: "Ассалому алейкум\n\nБа шумо кадом маълумоти курсро равон кунем?" }]);
    await sendToContact(fakeContact() as never, "Ассалому алейкум! Курс 70 сомони");
    expect(vi.mocked(sendText).mock.calls[0][1]).toBe("Курс 70 сомони");
    const recorded = db.model("message").create.mock.calls.map((c) => (c[0] as { data: { text: string } }).data.text);
    expect(recorded).toContain("Курс 70 сомони");
    expect(recorded.join("\n")).not.toMatch(/Ассалому/);
  });
});

describe("п.4 Telegram или сайт — до оплаты", () => {
  it("«телеграм надорам» — запомнили «сайт» для этого человека", async () => {
    db.model("purchase").count.mockResolvedValue(0);
    const contact = fakeContact({ courseDeliveryChoice: null }) as unknown as Contact;
    expect(await rememberDeliveryPreference(contact, "Телеграм надорам, мешавад?")).toBe("web");
    expect(db.model("contact").updateMany).toHaveBeenCalledWith({ where: { id: "contact-1" }, data: { courseDeliveryChoice: "web" } });
  });
  it("ссылка уже выдана — способ молча не меняем", async () => {
    db.model("purchase").count.mockResolvedValue(1);
    expect(await rememberDeliveryPreference(fakeContact({ courseDeliveryChoice: null }) as unknown as Contact, "телеграм надорам")).toBeNull();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
  it("до оплаты бот говорит «в Telegram или на сайте»; выбран сайт — без Telegram-группы", async () => {
    const def = await deliveryPrompt({ channel: "INSTAGRAM", courseDeliveryChoice: null });
    expect(def).toContain("или на нашем сайте");
    expect(def).toContain("Никогда не говори, что без Telegram нельзя");
    const web = await deliveryPrompt({ channel: "INSTAGRAM", courseDeliveryChoice: "web" });
    expect(web).toContain("на нашем сайте");
    expect(web).toContain("Не отправляй его в Telegram-группу");
  });
});

describe("не повторять отправленное: файл помнится в истории", () => {
  it("вложение помечается своей ссылкой, и повтор узнаётся", async () => {
    await sendAttachmentToContact(fakeContact() as never, "https://x/menu.jpg", "image");
    expect(db.model("message").updateMany).toHaveBeenCalledWith({
      where: { mid: "mid-att", direction: "OUT" },
      data: { payload: "media:https://x/menu.jpg" },
    });
    db.model("message").findFirst.mockResolvedValue({ id: "row" });
    expect(await mediaAlreadySent("contact-1", "https://x/menu.jpg")).toBe(true);
    db.model("message").findFirst.mockResolvedValue(null);
    expect(await mediaAlreadySent("contact-1", "https://x/other.jpg")).toBe(false);
  });
});
