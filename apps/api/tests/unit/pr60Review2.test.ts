import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Второй проход ревью PR 60: тихий ответ на историю, отложенный ответ после «спасибо»,
 * повтор при safe_intent, гонка снятия перехвата, разовое разрешение, список личных контактов.
 */
const reply = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../src/ai.js", () => ({
  aiReply: (...args: unknown[]) => reply(...args),
  registerOfflineIfAsked: vi.fn(async () => false),
  rescueIncomingImages: vi.fn(async () => []),
}));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "mid") }));
const findOwnMedia = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("../../src/ownMedia.js", () => ({ findOwnMedia: (...a: unknown[]) => findOwnMedia(...a), viewableUrl: vi.fn() }));
vi.mock("../../src/funnel.js", () => ({
  upsertContact: vi.fn(async () => fakeContact()),
  handleIncomingDm: vi.fn(async () => false),
  handleComment: vi.fn(),
}));
vi.mock("../../src/ai/styleLearning.js", () => ({ rememberOwnerReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));
vi.mock("../../src/ai/media.js", () => ({ fetchAttachment: vi.fn(async () => null) }));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));
vi.mock("../../src/debounce.js", () => ({ debounceMessage: vi.fn() }));

import { retryPendingAiReplies } from "../../src/aiReplyRetry.js";
import { resolveTakeover, releaseExpiredTakeovers } from "../../src/ai/ownerTakeover.js";
import { normalizeEntry, importPersonalList, removePersonalEntry } from "../../src/ai/personalList.js";
import { contactAutomationBlocked, takeoverOverrideActive, withTakeoverOverride } from "../../src/messaging/automation.js";
import { QUIET_STORY_PAYLOAD } from "../../src/ai/storyRelevance.js";
import { deliberateSilenceSince, resetDeliberateSilence } from "../../src/ai/deliberateSilence.js";
import { handleMessage } from "../../src/webhook.js";

let db: PrismaMock;
const now = new Date("2026-11-08T12:00:00Z");
const ago = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  db = mockPrisma();
  reply.mockClear();
  resetDeliberateSilence();
  db.model("setting").findUnique.mockResolvedValue(null);
  db.model("message").findFirst.mockResolvedValue(null);
});
afterEach(restorePrisma);

function pendingRow(contact: Record<string, unknown> = {}, text = "Сколько стоит курс?") {
  return { id: "p1", contactId: "contact-1", text, snapshotAt: ago(3), attempts: 0, delayNoticeAt: null, contact: fakeContact(contact) };
}

describe("находка 4: тихий ответ на историю", () => {
  it("пишет осознанное молчание и помечает входящее, чтобы очередь его не считала", async () => {
    findOwnMedia.mockResolvedValueOnce({ caption: "Новый торт" });
    db.model("message").create.mockResolvedValue({});
    await handleMessage({
      sender: { id: "ig-1" },
      recipient: { id: "page-1" },
      message: { mid: "m-story", text: "красота", reply_to: { story: { id: "s1", url: "https://cdn/x" } } },
    } as never);
    expect(db.model("message").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mid: "m-story", payload: QUIET_STORY_PAYLOAD }),
    });
    expect(deliberateSilenceSince("contact-1", new Date(0))).toContain("историю");
  });
  it("отложенный ответ переживает тихий ответ на историю", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("message").findMany.mockResolvedValue([{ text: "красота", payload: QUIET_STORY_PAYLOAD }]);
    await retryPendingAiReplies();
    expect(reply).toHaveBeenCalledTimes(1);
  });
  it("настоящее новое сообщение по-прежнему делает попытку устаревшей", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("message").findMany.mockResolvedValue([{ text: "а ещё вопрос про рассрочку", payload: null }]);
    await retryPendingAiReplies();
    expect(reply).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").delete).toHaveBeenCalled();
  });
});

describe("находка 6: «спасибо» после вопроса", () => {
  it("не стирает отложенный ответ на вопрос", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("message").findMany.mockResolvedValue([{ text: "Рахмат", payload: null }]);
    await retryPendingAiReplies();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe("исходящее без текста (фото) считается ответом", () => {
  it("условие допускает text = null", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([pendingRow()]);
    db.model("message").findFirst.mockResolvedValue({ id: "out-photo" });
    await retryPendingAiReplies();
    const where = (db.model("message").findFirst.mock.calls[0]![0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toContainEqual({ text: null });
    expect(db.model("pendingAiReply").delete).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("находка 8: повтор при safe_intent", () => {
  it("aiReply вызывается внутри разового разрешения", async () => {
    const taken = ago(5);
    db.model("pendingAiReply").findMany.mockResolvedValue([
      pendingRow({ humanTakenOverAt: taken }, "курс не открывается, дайте ссылку заново"),
    ]);
    db.model("message").findFirst.mockImplementation(async (a: { where: { byHuman?: boolean } }) => (a.where.byHuman ? { createdAt: ago(10) } : null));
    db.model("purchase").count.mockResolvedValue(1);
    let overrideSeen = false;
    reply.mockImplementationOnce(async () => {
      overrideSeen = takeoverOverrideActive("contact-1");
    });
    await retryPendingAiReplies();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(overrideSeen).toBe(true);
    expect(db.model("contact").updateMany).not.toHaveBeenCalled(); // перехват остаётся
  });
});

describe("находка 7: разовое разрешение не шире задуманного", () => {
  it("таймер паузы (реакция хозяйки) разовым разрешением не обходится", async () => {
    const c = { id: "contact-1", humanTakenOverAt: new Date(), humanSilencedUntil: new Date(Date.now() + 600_000) };
    await withTakeoverOverride("contact-1", async () => {
      expect(contactAutomationBlocked(c)).toBe(true);
      expect(contactAutomationBlocked({ ...c, humanSilencedUntil: null })).toBe(false);
    });
  });
  it("«спасибо» при выключенных реакциях не даёт свободного ИИ-ответа под паузой", async () => {
    db.model("setting").findUnique.mockImplementation(async (a: { where: { key: string } }) => (a.where.key === "reactionsEnabled" ? { value: "false" } : null));
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 2 * 60_000) });
    const d = await resolveTakeover({ id: "c1", humanTakenOverAt: new Date(now.getTime() - 5 * 60_000) }, { text: "Рахмат", at: now }, now);
    expect(d).toEqual({ action: "hold", until: null });
  });
  it("«спасибо» при включённых реакциях по-прежнему безопасно", async () => {
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 2 * 60_000) });
    const d = await resolveTakeover({ id: "c1", humanTakenOverAt: new Date(now.getTime() - 5 * 60_000) }, { text: "Рахмат", at: now }, now);
    expect(d).toEqual({ action: "answer", why: "safe_intent" });
  });
});

describe("находка 12: гонка снятия перехвата", () => {
  it("хозяйка написала снова между решением и снятием: перехват не стираем, молчим", async () => {
    const taken = new Date(now.getTime() - 40 * 60_000);
    db.model("message").findFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 30 * 60_000) });
    db.model("contact").updateMany.mockResolvedValue({ count: 0 });
    const d = await resolveTakeover({ id: "c1", humanTakenOverAt: taken }, { text: "Алло?", at: now }, now);
    expect(d).toEqual({ action: "hold", until: null });
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", humanTakenOverAt: taken } }));
  });
  it("тик очистки тоже снимает только тот перехват, который проверил", async () => {
    const taken = new Date(now.getTime() - 30 * 3_600_000);
    db.model("contact").findMany.mockResolvedValue([{ id: "old", humanTakenOverAt: taken }]);
    db.model("contact").updateMany.mockResolvedValue({ count: 0 });
    expect(await releaseExpiredTakeovers(now)).toBe(0);
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "old", humanTakenOverAt: taken } }));
  });
});

describe("находка 5: список личных контактов", () => {
  it("местный номер получает код 992", () => {
    expect(normalizeEntry("90 123 45 67")).toBe("992901234567");
    expect(normalizeEntry("090 123 45 67")).toBe("992901234567");
    expect(normalizeEntry("+992 90 123-45-67")).toBe("992901234567");
  });
  it("номер ищется точно по чату, а не по contains (иначе цепляется номер школы)", async () => {
    await importPersonalList("901234567");
    const where = (db.model("contact").updateMany.mock.calls[0]![0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toEqual([{ name: "+992901234567" }, { igUserId: { endsWith: ":992901234567@c.us" } }]);
  });
  it("запись удаляется из списка и пометка снимается только у контактов списка", async () => {
    db.model("setting").findUnique.mockResolvedValue({ value: "mama_nick\n992901234567" });
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    const r = await removePersonalEntry("@Mama_Nick");
    expect(r).toEqual({ removed: true, unmarked: 1 });
    expect(db.model("setting").upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: "992901234567" } }));
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ username: "mama_nick", personal: true, personalReason: expect.stringContaining("Список") }) }),
    );
  });
});
