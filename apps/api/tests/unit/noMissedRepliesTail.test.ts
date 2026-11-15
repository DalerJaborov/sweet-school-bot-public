import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * КЛАСС B аудита 15.11.2026: клиент ответил через 10–90 с после ответа бота, а бот
 * промолчал, и журнал решений пуст. Данные выдуманные.
 *
 * Где хвост выпадал на самом деле:
 *  1) эхо нашего же ответа обгоняло ответ Graph API — webhook.ts записывал его как
 *     «Ширин ответила сама»: пауза бота, отмена воронки, и сообщение клиента в это
 *     окно молча отбрасывалось («пауза — молчим»), а сторож его не видел;
 *  2) бот сам поставил тишину («сейчас уточню», «зову Ширин») — хвост отбрасывался
 *     без следа, и после часа его не подбирал никто (см. noMissedRepliesWatch.test.ts);
 *  3) очередь дебаунса хвост НЕ теряет — тест ниже это закрепляет.
 */
const sendText = vi.fn();
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendAttachment: vi.fn(async () => "mid-att"),
  sendPrivateReply: vi.fn(async () => "mid-private"),
  channelOf: (c: { channel?: string }) => c.channel ?? "INSTAGRAM",
  metaChannelOf: (c: { channel: string }) => c.channel,
}));
vi.mock("../../src/whatsapp/transport.js", () => ({ sendWhatsAppText: vi.fn(), sendWhatsAppAttachment: vi.fn() }));
vi.mock("../../src/messaging/humanize.js", () => ({ humanizeForContact: async (_id: string, t: string) => t }));
vi.mock("../../src/greeting.js", () => ({ stripRepeatGreeting: async (_id: string | null, t: string) => t }));
vi.mock("../../src/voice.js", () => ({ toOwnerVoice: (t: string) => t }));
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
vi.mock("../../src/debounce.js", async (original) => ({
  ...(await original<typeof import("../../src/debounce.js")>()),
  debounceMessage: (...a: unknown[]) => debounceMessage(...a),
}));
vi.mock("../../src/profiles.js", () => ({
  silenceIfFollowedByBusiness: vi.fn(async () => false),
  releaseFollowSilenceIfClient: vi.fn(async (c: unknown) => c),
}));
vi.mock("../../src/course/deliveryChoice.js", () => ({ handleDeliveryChoiceReply: vi.fn(async () => false) }));
vi.mock("../../src/ai/personalContact.js", () => ({ looksPersonal: () => false }));
vi.mock("../../src/ai/abuseFilter.js", () => ({ detectAbuse: () => null }));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));
vi.mock("../../src/ownMedia.js", () => ({ findOwnMedia: vi.fn(async () => null), viewableUrl: vi.fn() }));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn(async () => null) }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));

import { cancelPendingFunnelSteps, upsertContact } from "../../src/funnel.js";
import { handleEcho, handleMessage, type MessagingEvent } from "../../src/webhook.js";
import { sendToContact } from "../../src/messaging/send.js";
import { runAfterPrevious, WINDOW_MS } from "../../src/debounce.js";
import * as database from "../../src/db.js";

let db: PrismaMock;
const client = {
  ...fakeContact(),
  humanTakenOverAt: null,
  humanSilencedUntil: null,
  spamBlockedAt: null,
  whatsappSavedContact: false,
};

beforeEach(() => {
  db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("setting").findUnique.mockResolvedValue(null);
  db.model("contact").findUnique.mockResolvedValue(client);
  db.model("message").create.mockResolvedValue({});
  sendText.mockReset();
  debounceMessage.mockReset();
  vi.mocked(cancelPendingFunnelSteps).mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("КЛАСС B, причина 1: эхо нашего ответа обгоняет mid от Graph API", () => {
  it("эхо, пришедшее во время отправки, НЕ становится «ответом Ширин»: ни паузы, ни отмены воронки", async () => {
    const recorded = new Set<string>();
    db.model("message").findUnique.mockImplementation(async ({ where }: { where: { mid: string } }) =>
      recorded.has(where.mid) ? { id: "row", mid: where.mid, byHuman: false } : null,
    );
    db.model("message").create.mockImplementation(async ({ data }: { data: { mid?: string; byHuman?: boolean } }) => {
      if (data.mid && !data.byHuman) recorded.add(data.mid);
      return {};
    });
    let echo: Promise<void> | undefined;
    sendText.mockImplementation(async () => {
      // Meta доставила эхо раньше, чем вернула нам mid.
      echo = handleEcho({
        sender: { id: "page-1" },
        recipient: { id: "ig-1" },
        message: { mid: "mid-bot-1", text: "Курс 70 сомони", is_echo: true },
      });
      await new Promise((r) => setTimeout(r, 5));
      return "mid-bot-1";
    });

    await sendToContact(client, "Курс 70 сомони");
    await echo;

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ humanTakenOverAt: expect.any(Date) }) }),
    );
    expect(cancelPendingFunnelSteps).not.toHaveBeenCalled();
  });

  it("настоящий ответ Ширин (бот этому человеку не пишет) — пауза ставится сразу, как раньше", async () => {
    db.model("message").findUnique.mockResolvedValue(null);
    vi.mocked(upsertContact).mockResolvedValueOnce(client as never);
    await handleEcho({
      sender: { id: "page-1" },
      recipient: { id: "ig-1" },
      message: { mid: "mid-shirin-1", is_echo: true },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(cancelPendingFunnelSteps).toHaveBeenCalledWith("contact-1", expect.stringMatching(/Ширин/));
  });
});

describe("КЛАСС B, причина 2: хвост во время «ждём Ширин» оставляет след, а не тишину", () => {
  it("бот сказал «уточню» (тишина час), клиент дописал — входящее записано и в журнале «ждём человека»", async () => {
    vi.mocked(upsertContact).mockResolvedValueOnce({
      ...client,
      humanSilencedUntil: new Date(Date.now() + 50 * 60_000),
    } as never);
    await handleMessage({ sender: { id: "ig-1" }, message: { mid: "mid-tail-1", text: "Хоп, а кай сар мешавад?" } });
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactId: "contact-1",
          action: "wait",
          reason: expect.stringMatching(/^human_requested/),
        }),
      }),
    );
  });

  it("Ширин подключилась, пока ждали пачку сообщений, — молчание тоже со следом (ответит сторож после паузы)", async () => {
    await handleMessage({ sender: { id: "ig-1" }, message: { mid: "mid-tail-2", text: "Нарх чанд?" } });
    const onFlush = debounceMessage.mock.calls[0][4] as (t: string, a: unknown[], r: unknown[]) => Promise<void>;
    db.model("contact").findUnique.mockResolvedValue({ ...client, humanTakenOverAt: new Date() });
    await onFlush("Нарх чанд?", [], []);
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^human_takeover/) }),
      }),
    );
  });
});

describe("КЛАСС B, причина 3 (опровергнута): очередь дебаунса хвост не теряет", () => {
  it("сообщение, пришедшее пока бот формирует и отправляет ответ, обрабатывается сразу после него", async () => {
    const realDebounce = await vi.importActual<typeof import("../../src/debounce.js")>("../../src/debounce.js");
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      let finishFirst!: () => void;
      const first = realDebounce.debounceMessage("tail-contact", "Курс чанд?", [], [], async (t) => {
        order.push(`start:${t}`);
        await new Promise<void>((r) => (finishFirst = r));
        order.push(`end:${t}`);
      });
      await vi.advanceTimersByTimeAsync(WINDOW_MS); // окно кончилось — бот «пишет» ответ
      const tail = realDebounce.debounceMessage("tail-contact", "Онлайн аст?", [], [], async (t) => {
        order.push(`start:${t}`);
      });
      await vi.advanceTimersByTimeAsync(WINDOW_MS); // окно хвоста кончилось, первый ответ ещё идёт
      expect(order).toEqual(["start:Курс чанд?"]);
      finishFirst();
      await Promise.all([first, tail]);
      expect(order).toEqual(["start:Курс чанд?", "end:Курс чанд?", "start:Онлайн аст?"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("сбой первого ответа не роняет хвост", async () => {
    const order: string[] = [];
    runAfterPrevious("tail-fail", async () => {
      throw new Error("Meta 500");
    });
    runAfterPrevious("tail-fail", () => {
      order.push("tail");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["tail"]);
  });
});

describe("«позовите человека»: живой вебхук молчит до ответа Ширин, чек проверяется", () => {
  const HOLD = new Date("2999-01-01T00:00:00Z");
  const held = { ...client, humanSilencedUntil: HOLD, humanRequestedAt: new Date(Date.now() - 5 * 3_600_000) };

  it("через 5 часов клиент пишет снова — бот не отвечает, в журнале «просил человека»", async () => {
    vi.mocked(upsertContact).mockResolvedValueOnce(held as never);
    await handleMessage({ sender: { id: "ig-1" }, message: { mid: "mid-held-1", text: "Нархи курс чанд?" } });
    expect(debounceMessage).not.toHaveBeenCalled();
    expect(db.model("replyGate").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^asked_human/) }) }),
    );
  });

  it("ДЕНЬГИ: прислал чек во время удержания — чек проверяется сразу", async () => {
    const { verifyReceiptsNow, rescueIncomingImages } = await import("../../src/ai.js");
    vi.mocked(upsertContact).mockResolvedValueOnce(held as never);
    const rescued = [{ buffer: Buffer.from("x"), mimeType: "image/jpeg", hash: "h", url: "/media/x.jpg", queuedId: "q1" }];
    vi.mocked(rescueIncomingImages).mockResolvedValueOnce(rescued as never);
    await handleMessage({
      sender: { id: "ig-1" },
      message: { mid: "mid-held-2", attachments: [{ type: "image", payload: { url: "https://cdn.example/r.jpg" } }] },
    });
    expect(verifyReceiptsNow).toHaveBeenCalledWith(expect.objectContaining({ id: "contact-1" }), rescued);
    expect(debounceMessage).not.toHaveBeenCalled();
  });

  it("реакция Ширин (сердечко) удержание не укорачивает до 10 минут", async () => {
    vi.mocked(upsertContact).mockResolvedValueOnce(held as never);
    await handleMessage({ sender: { id: "page-1" }, recipient: { id: "ig-1" }, reaction: { mid: "m", action: "react", reaction: "love" } }, "page-1");
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
});
