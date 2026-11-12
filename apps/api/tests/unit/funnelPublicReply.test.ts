import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, fakeFunnel, fakeStep, type PrismaMock } from "../helpers.js";
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "sent"), sendAttachmentToContact: vi.fn() }));
vi.mock("../../src/instagram.js", () => ({
  sendPrivateReply: vi.fn(async () => "mid-1"),
  replyToComment: vi.fn(async () => "reply-1"),
  deleteComment: vi.fn(),
  metaChannelOf: () => "INSTAGRAM",
  mediaPermalink: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({ aiReplyToComment: vi.fn(async () => undefined) }));
vi.mock("../../src/systemAlerts.js", () => ({ notifyFunnelGaveUp: vi.fn() }));
vi.mock("../../src/profiles.js", () => ({
  silenceIfFollowedByBusiness: vi.fn(async () => false),
  releaseFollowSilenceIfClient: vi.fn(async (c: unknown) => c),
}));
import { handleComment, COMMENT_PUBLIC_REPLIES } from "../../src/funnel.js";
import { sendPrivateReply, replyToComment } from "../../src/instagram.js";
import { aiReplyToComment } from "../../src/ai.js";
import { silenceIfFollowedByBusiness } from "../../src/profiles.js";
import * as database from "../../src/db.js";

/**
 * Публичный ответ «написали вам в директ» под комментарием (владелец 08.11.2026):
 * уходит только после реально отправленного первого шага воронки, никогда —
 * личным контактам и знакомым Ширин, и его сбой не ломает воронку.
 */
let db: PrismaMock;
let commentSeq = 0;
const funnel = fakeFunnel({ trigger: "COMMENT", anyComment: true });
const input = () => ({ commentId: `c-${++commentSeq}`, mediaId: "post", igUserId: "customer", username: "client", text: "нарх чанд?" });

function setContact(overrides: Record<string, unknown> = {}) {
  const contact = fakeContact(overrides);
  db.model("contact").upsert.mockResolvedValue(contact);
  // Проверка перед каждой отправкой (assertContactMessagingAllowed) читает контакт заново.
  db.model("contact").findUnique.mockResolvedValue(contact);
  return contact;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("funnel").findMany.mockResolvedValue([funnel]);
  db.model("funnelStep").findFirst.mockResolvedValue(fakeStep({ order: 1, delaySeconds: 0, text: "Салом! Курсҳои мо:", buttons: "[]" }));
  db.model("delivery").findUnique.mockResolvedValue(null);
  db.model("delivery").create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "delivery-1", failCount: 0, ...data, contact: fakeContact(),
  }));
  db.model("setting").findUnique.mockResolvedValue(null);
  setContact();
});
afterEach(() => { restorePrisma(); vi.restoreAllMocks(); });

describe("публичный ответ под комментарием", () => {
  it("после старта воронки уходит одна из таджикских фраз под тот же комментарий", async () => {
    const i = input();
    await handleComment(i);
    expect(sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(replyToComment).toHaveBeenCalledTimes(1);
    const [commentId, text, channel] = vi.mocked(replyToComment).mock.calls[0];
    expect(commentId).toBe(i.commentId);
    expect(COMMENT_PUBLIC_REPLIES).toContain(text);
    expect(channel).toBe("INSTAGRAM");
  });

  it("фраз несколько и нет запретного «лутфан» / обращения на «ту»", () => {
    expect(new Set(COMMENT_PUBLIC_REPLIES).size).toBeGreaterThanOrEqual(4);
    for (const t of COMMENT_PUBLIC_REPLIES) {
      expect(t.toLowerCase()).not.toContain("лутфан");
      expect(t.toLowerCase()).not.toMatch(/(^|\s)ту(\s|$)/);
    }
  });

  it("рубильник commentPublicReplyEnabled=false — директ уходит, публичного ответа нет", async () => {
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "commentPublicReplyEnabled" ? { key: where.key, value: "false" } : null);
    await handleComment(input());
    expect(sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("личному контакту — ни воронки, ни публичного ответа", async () => {
    setContact({ personal: true });
    await handleComment(input());
    expect(sendPrivateReply).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(db.model("delivery").create).not.toHaveBeenCalled();
  });

  it("знакомой (Ширин на неё подписана) — ни воронки, ни публичного ответа", async () => {
    vi.mocked(silenceIfFollowedByBusiness).mockResolvedValueOnce(true);
    await handleComment(input());
    expect(sendPrivateReply).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(db.model("delivery").create).not.toHaveBeenCalled();
  });

  it("знакомой под постом без воронки — и ИИ не отвечает", async () => {
    db.model("funnel").findMany.mockResolvedValue([]);
    vi.mocked(silenceIfFollowedByBusiness).mockResolvedValueOnce(true);
    await handleComment(input());
    expect(aiReplyToComment).not.toHaveBeenCalled();
  });

  it("первый шаг в директ не ушёл — публично «написали в директ» не пишем", async () => {
    vi.mocked(sendPrivateReply).mockRejectedValueOnce(new Error("network unavailable"));
    await handleComment(input());
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("ошибка Meta на публичном ответе не ломает воронку — только запись в журнал", async () => {
    vi.mocked(replyToComment).mockRejectedValueOnce(new Error("(#10) Application does not have permission"));
    await expect(handleComment(input())).resolves.toBeUndefined();
    expect(sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(database.logError).toHaveBeenCalledWith("funnel:publicReply", expect.any(Error));
    // Доставка не ушла в «повтор/провал» из-за публичного ответа.
    expect(db.model("delivery").update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failCount: expect.any(Number) }) }));
    expect(db.model("seenComment").create).toHaveBeenCalledTimes(1);
  });
});

/**
 * Разбор 09.11.2026 («никто не должен оставаться без ответа в комментах»):
 * повторный комментарий того, кто уже проходил воронку, раньше не получал
 * НИЧЕГО; ответ ИИ уходил в директ без отметки под комментарием; итог
 * обработки нигде не хранился, и сторож не мог напомнить о пропущенном.
 */
describe("комментарий не остаётся без ответа", () => {
  function seenOutcome(): string | undefined {
    const call = db.model("seenComment").create.mock.calls[0]?.[0] as { data: { outcome?: string } } | undefined;
    return call?.data.outcome;
  }

  it("воронку уже проходил (окно повтора не прошло) — отвечает ИИ, а не тишина", async () => {
    db.model("delivery").findUnique.mockResolvedValue({ id: "old", createdAt: new Date(), failCount: 0 });
    vi.mocked(aiReplyToComment).mockResolvedValueOnce("ai");
    await handleComment(input());
    expect(aiReplyToComment).toHaveBeenCalledTimes(1);
    expect(db.model("delivery").create).not.toHaveBeenCalled();
    expect(seenOutcome()).toBe("ai");
  });

  it("ИИ ответил в директ — под комментарием та же короткая отметка «написали в директ»", async () => {
    db.model("funnel").findMany.mockResolvedValue([]);
    vi.mocked(aiReplyToComment).mockResolvedValueOnce("ai");
    await handleComment(input());
    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(COMMENT_PUBLIC_REPLIES).toContain(vi.mocked(replyToComment).mock.calls[0][1]);
  });

  it("ИИ решил, что писать нечего («Офарин!») — публичное сердечко, не тишина", async () => {
    db.model("funnel").findMany.mockResolvedValue([]);
    vi.mocked(aiReplyToComment).mockResolvedValueOnce("no_reply");
    await handleComment(input());
    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(COMMENT_PUBLIC_REPLIES).not.toContain(vi.mocked(replyToComment).mock.calls[0][1]);
    expect(seenOutcome()).toBe("public_heart");
  });

  it("ответы ИИ выключены — итог «ai_off» записан, чтобы сторож напомнил Ширин", async () => {
    db.model("funnel").findMany.mockResolvedValue([]);
    vi.mocked(aiReplyToComment).mockResolvedValueOnce("ai_off");
    await handleComment(input());
    expect(replyToComment).not.toHaveBeenCalled();
    expect(seenOutcome()).toBe("ai_off");
  });

  it("Ширин ведёт переписку с этим человеком — ни воронки, но итог «waiting_human» для напоминания", async () => {
    setContact({ humanTakenOverAt: new Date() });
    await handleComment(input());
    expect(sendPrivateReply).not.toHaveBeenCalled();
    expect(seenOutcome()).toBe("waiting_human");
  });
});
