import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Разбор 09.11.2026 («никто не должен оставаться без ответа»):
 *  - ответ на НАШУ историю, которую не нашли в ленте (свежая, исчезла, Meta не
 *    отдала /me/stories), считался «чужим роликом» — и вопрос пропадал целиком;
 *  - чужая пересланная публикация с вопросом про курс — тоже тишина;
 *  - авто-отметка «Ширин подписана» глушила навсегда даже «сколько стоит курс?»;
 *  - эхо Ширин обновляет отметку паузы на каждом её ответе (пауза временная).
 */
vi.mock("../../src/course/deliveryChoice.js", () => ({ handleDeliveryChoiceReply: vi.fn(async () => false) }));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "mid-out") }));
vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => fakeContact()),
  handleIncomingDm: vi.fn(async () => false),
  handleComment: vi.fn(),
  cancelPendingFunnelSteps: vi.fn(async () => 0),
  clientMessageStopsFunnel: vi.fn(async () => true),
  settleDeferredFunnel: vi.fn(async () => undefined),
}));
vi.mock("../../src/ai.js", () => ({
  aiReply: vi.fn(async () => undefined),
  registerOfflineIfAsked: vi.fn(async () => false),
  rescueIncomingImages: vi.fn(async () => []),
  verifyReceiptsNow: vi.fn(async () => undefined),
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

import { upsertContact } from "../../src/funnel.js";
import { findOwnMedia } from "../../src/ownMedia.js";
import { handleMessage, handleEcho, type MessagingEvent } from "../../src/webhook.js";
import { FOLLOW_PERSONAL_REASON } from "../../src/profiles.js";

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
  debounceMessage.mockClear();
  vi.mocked(findOwnMedia).mockReset().mockResolvedValue(null);
  vi.mocked(upsertContact).mockReset().mockResolvedValue(fakeContact({ humanSilencedUntil: null }) as never);
  db.model("setting").findUnique.mockResolvedValue(null);
  db.model("message").create.mockResolvedValue({});
  db.model("message").findMany.mockResolvedValue([]);
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

function dm(message: MessagingEvent["message"]): MessagingEvent {
  return { sender: { id: "ig-client" }, recipient: { id: "page-1" }, message: { mid: `mid-${Math.random()}`, ...message } };
}
const aiText = (): string => debounceMessage.mock.calls[0]?.[1] as string;

describe("ответ на историю и пересланные публикации", () => {
  it("ГЛАВНОЕ: ответ на НАШУ историю, которой нет в ленте, доходит до бота вместе с вопросом", async () => {
    await handleMessage(dm({ text: "Нархи курс чанд?", reply_to: { story: { id: "story-1", url: "https://cdn/story" } } }));
    expect(debounceMessage).toHaveBeenCalledTimes(1);
    expect(aiText()).toContain("НАШУ историю");
    expect(aiText()).toContain("Нархи курс чанд?");
    expect(db.model("message").create).toHaveBeenCalled();
  });

  it("пересланный рилс ищется и по reel_video_id — это id нашей публикации", async () => {
    await handleMessage(dm({ attachments: [{ type: "ig_reel", payload: { url: "https://ig/reel", reel_video_id: 1789 } }] }));
    expect(findOwnMedia).toHaveBeenCalledWith({ url: "https://ig/reel", mediaId: "1789" });
  });

  it("чужая публикация с вопросом про курс — отвечаем на вопрос, саму публикацию не описываем", async () => {
    await handleMessage(dm({ text: "Сколько стоит курс?", attachments: [{ type: "share", payload: { url: "https://instagram.com/p/OTHER/" } }] }));
    expect(debounceMessage).toHaveBeenCalledTimes(1);
    expect(aiText()).toContain("чужую публикацию");
    expect(aiText()).toContain("Сколько стоит курс?");
  });

  it("чужая публикация без вопроса про курс — молчим, как решил владелец", async () => {
    await handleMessage(dm({ text: "ха-ха смотри", attachments: [{ type: "share", payload: { url: "https://instagram.com/p/OTHER/" } }] }));
    await handleMessage(dm({ attachments: [{ type: "ig_reel", payload: { url: "https://instagram.com/reel/OTHER/" } }] }));
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("message").create).not.toHaveBeenCalled();
  });
});

describe("знакомая по подписке, которая пишет про курс, — клиент", () => {
  const followed = () => fakeContact({ personal: true, personalReason: FOLLOW_PERSONAL_REASON, humanSilencedUntil: null });

  it("ГЛАВНОЕ: вопрос про цену снимает авто-отметку, и бот отвечает", async () => {
    vi.mocked(upsertContact).mockResolvedValue(followed() as never);
    await handleMessage(dm({ text: "Курс чанд пул?" }));
    expect(db.model("contact").update).toHaveBeenCalledWith({ where: { id: "contact-1" }, data: { personal: false, personalReason: null } });
    expect(debounceMessage).toHaveBeenCalledTimes(1);
  });

  it("нажала кнопку воронки — тоже клиент", async () => {
    vi.mocked(upsertContact).mockResolvedValue(followed() as never);
    await handleMessage(dm({ text: "Ҳа", quick_reply: { payload: "step:f1:2" } }));
    expect(db.model("contact").update).toHaveBeenCalledWith(expect.objectContaining({ data: { personal: false, personalReason: null } }));
  });

  it("болтовня без признаков клиента — отметка остаётся, бот молчит", async () => {
    vi.mocked(upsertContact).mockResolvedValue(followed() as never);
    await handleMessage(dm({ text: "Офарин, зебо шудааст" }));
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(debounceMessage).not.toHaveBeenCalled();
  });

  it("ручную отметку «личный» бот не снимает никогда", async () => {
    vi.mocked(upsertContact).mockResolvedValue(fakeContact({ personal: true, personalReason: "Отмечен вручную" }) as never);
    await handleMessage(dm({ text: "Курс чанд пул?" }));
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(debounceMessage).not.toHaveBeenCalled();
  });
});

describe("эхо Ширин", () => {
  it("каждое её сообщение сдвигает отметку паузы (раньше — только первое, навсегда)", async () => {
    vi.useFakeTimers();
    try {
      db.model("message").findUnique.mockResolvedValue(null);
      const task = handleEcho({ sender: { id: "page-1" }, recipient: { id: "ig-1" }, message: { mid: "echo-2", is_echo: true } });
      await vi.advanceTimersByTimeAsync(20_000);
      await task;
      expect(db.model("contact").updateMany).toHaveBeenCalledWith({
        where: { id: "contact-1" },
        data: { humanTakenOverAt: expect.any(Date), humanTakeoverMid: "echo-2", humanSilencedUntil: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
