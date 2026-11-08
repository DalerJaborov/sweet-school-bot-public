import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

// Аудит молчания 08.11.2026: эхо НАШИХ сообщений не должно становиться «ответила хозяйка».
vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => fakeContact()),
  handleIncomingDm: vi.fn(),
  handleComment: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({ aiReply: vi.fn(), rescueIncomingImages: vi.fn() }));
vi.mock("../../src/debounce.js", () => ({ debounceMessage: vi.fn() }));
vi.mock("../../src/ai/personalContact.js", () => ({ looksPersonal: () => false }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));
vi.mock("../../src/ownMedia.js", () => ({ findOwnMedia: vi.fn(), viewableUrl: vi.fn() }));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn(async () => null) }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));

import { handleEcho } from "../../src/webhook.js";
import { trackOwnSend, resetOwnSendLedger } from "../../src/ai/ownSendLedger.js";
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";

let db: PrismaMock;
beforeEach(() => {
  vi.useFakeTimers();
  db = mockPrisma();
  db.model("message").findUnique.mockResolvedValue(null);
  db.model("message").findFirst.mockResolvedValue(null);
  resetOwnSendLedger();
});
afterEach(() => { restorePrisma(); vi.useRealTimers(); });

async function finish(task: Promise<unknown>) {
  await vi.advanceTimersByTimeAsync(25_000);
  await task;
}

describe("эхо своих сообщений не выключает бота", () => {
  it("ГОНКА: эхо прилетело раньше, чем Graph вернул mid — паузы нет", async () => {
    let resolveSend!: (v: { message_id: string }) => void;
    const sending = trackOwnSend("ig-1", "Салом", () => new Promise((resolve) => { resolveSend = resolve as typeof resolveSend; }));
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-race", text: "Салом", is_echo: true } });
    await vi.advanceTimersByTimeAsync(700); // эхо уже ждёт ответа Graph
    resolveSend({ message_id: "mid-race" });
    await sending;
    await finish(echo);

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("Graph не вернул message_id (AMBIGUOUS), сообщение дошло: эхо с тем же текстом — не хозяйка, запись сохраняется", async () => {
    await trackOwnSend("ig-1", "Ҳа, ин курс 70 сомонӣ", async () => { throw new MetaDeliveryError("AMBIGUOUS", 0); }).catch(() => undefined);
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-amb", text: "Ҳа, ин курс 70 сомонӣ", is_echo: true } });
    await finish(echo);

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.model("message").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mid: "mid-amb", direction: "OUT", byHuman: false }) })
    );
  });

  it("Graph ответил 200 без message_id: картинка (вложение), эхо без текста — тоже не хозяйка", async () => {
    await trackOwnSend("ig-1", null, async () => ({})); // ни mid, ни исключения
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-img", is_echo: true, attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] } });
    await finish(echo);

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("КОНТРОЛЬ: настоящий ответ хозяйки (другой текст) по-прежнему включает паузу", async () => {
    await trackOwnSend("ig-1", "Салом", async () => { throw new MetaDeliveryError("AMBIGUOUS", 0); }).catch(() => undefined);
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-owner", text: "Привет, это Ширин, отвечаю сама", is_echo: true } });
    await finish(echo);

    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ humanTakeoverMid: "mid-owner" }) })
    );
  });

  it("окончательный отказ Meta (окно 24 ч) ничего не доставил — такой текст хозяйки не прячем", async () => {
    await trackOwnSend("ig-1", "Салом", async () => { throw new MetaDeliveryError("WINDOW", 400); }).catch(() => undefined);
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-owner2", text: "Салом", is_echo: true } });
    await finish(echo);

    expect(db.model("contact").updateMany).toHaveBeenCalled();
  });

  it("эхо другого получателя не поглощается чужой неоднозначной отправкой", async () => {
    await trackOwnSend("ig-2", "Салом", async () => { throw new MetaDeliveryError("AMBIGUOUS", 0); }).catch(() => undefined);
    const echo = handleEcho({ recipient: { id: "ig-1" }, message: { mid: "mid-o3", text: "Салом", is_echo: true } });
    await finish(echo);

    expect(db.model("contact").updateMany).toHaveBeenCalled();
  });
});
