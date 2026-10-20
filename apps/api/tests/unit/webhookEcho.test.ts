import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

// Всё, что handleEcho тянет снаружи, — моки: нас интересует только транзакция
// «записать эхо + замолчать боту» и то, что обучение не дублируется.
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

import { rememberOwnerReply } from "../../src/ai/styleLearning.js";
import { handleEcho, type MessagingEvent } from "../../src/webhook.js";

const echo: MessagingEvent = {
  sender: { id: "page-1" },
  recipient: { id: "ig-1" },
  message: { mid: "mid-echo-1", text: "Апачон, ҳа, ин курс 70 сомонӣ", is_echo: true },
};

/** Ошибка Prisma «уникальность нарушена» — второй вебхук с тем же mid. */
const duplicateMid = Object.assign(new Error("Unique constraint failed on mid"), { code: "P2002" });

describe("handleEcho — транзакция эха хозяйки", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("message").findUnique.mockResolvedValue(null); // это не наша отправка
    db.model("message").findFirst.mockResolvedValue({ text: "Курс чанд пул?" });
  });
  afterEach(restorePrisma);

  it("первый вебхук: сообщение и тишина бота пишутся в одной транзакции, обучение запускается", async () => {
    await handleEcho(echo);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.model("message").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mid: "mid-echo-1", byHuman: true, direction: "OUT" }) })
    );
    expect(db.model("contact").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { humanSilencedUntil: expect.any(Date) } })
    );
    expect(rememberOwnerReply).toHaveBeenCalledTimes(1);
    expect(rememberOwnerReply).toHaveBeenCalledWith("Курс чанд пул?", echo.message!.text, "TAKEOVER", undefined, "contact-1");
  });

  it("повторный вебхук с тем же mid: транзакция откатывается, обучение НЕ запускается второй раз", async () => {
    // Первая доставка прошла как обычно.
    await handleEcho(echo);
    // Вторая — Prisma отвечает дубликатом mid на create, до update дело не доходит.
    db.model("message").create.mockRejectedValueOnce(duplicateMid);
    await handleEcho(echo);

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.model("contact").update).toHaveBeenCalledTimes(1); // только из первой транзакции
    expect(rememberOwnerReply).toHaveBeenCalledTimes(1);
  });

  it("наша же отправка (mid уже в базе) — не эхо человека, ничего не делаем", async () => {
    db.model("message").findUnique.mockResolvedValue({ id: "m", mid: "mid-echo-1" });

    await handleEcho(echo);

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rememberOwnerReply).not.toHaveBeenCalled();
  });

  it("не P2002 (например, база недоступна) — тоже без обучения, но ошибка не глотается молча", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.model("message").create.mockRejectedValueOnce(new Error("SQLITE_BUSY"));

    await handleEcho(echo);

    expect(rememberOwnerReply).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("webhook:handleEcho:record"));
  });
});
