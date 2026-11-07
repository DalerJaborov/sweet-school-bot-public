import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
const reply = vi.fn(async () => undefined);
const send = vi.fn(async () => "notice-mid");
vi.mock("../../src/ai.js", () => ({ aiReply: (...args: unknown[]) => reply(...args as []) }));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...args: unknown[]) => send(...args as []) }));
import { retryPendingAiReplies, queuePendingAiReply } from "../../src/aiReplyRetry.js";
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";

let db: PrismaMock;
beforeEach(() => {
  db = mockPrisma();
  reply.mockClear(); send.mockClear();
  db.model("setting").findUnique.mockResolvedValue(null);
  db.model("message").findFirst.mockResolvedValue(null);
  db.model("pendingAiReply").updateMany.mockResolvedValue({ count: 1 });
});
afterEach(restorePrisma);

describe("AI delay queue", () => {
  it("does not multiply queued turns when a retry fails again", async () => {
    const snapshotAt = new Date();
    db.model("message").findFirst.mockResolvedValue({ createdAt: snapshotAt });
    db.model("pendingAiReply").findFirst.mockResolvedValue({ id: "existing" });
    await queuePendingAiReply("contact-1", "Сколько стоит курс?");
    expect(db.model("pendingAiReply").create).not.toHaveBeenCalled();
  });
  it("sends a notice after the second failed attempt but keeps the question queued", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([{ id: "pending", contactId: "contact-1", text: "Сколько стоит курс?", snapshotAt: new Date(), attempts: 1, delayNoticeAt: null, contact: fakeContact() }]);
    await retryPendingAiReplies();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.model("pendingAiReply").delete).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attempts: 2 }) }));
    for (const [arg] of db.model("message").findFirst.mock.calls) {
      if ((arg as any).where.direction === "OUT") expect((arg as any).where.text.notIn).toHaveLength(3);
    }
  });
  it("does not repeat a notice already claimed before a timeout or restart", async () => {
    db.model("pendingAiReply").findMany.mockResolvedValue([{ id: "pending", contactId: "contact-1", text: "Сколько стоит курс?", snapshotAt: new Date(), attempts: 2, delayNoticeAt: new Date(), contact: fakeContact() }]);
    await retryPendingAiReplies();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["AMBIGUOUS", "TOKEN", "WINDOW"] as const)("stops queued delivery after %s instead of replaying the answer", async (kind) => {
    db.model("pendingAiReply").findMany.mockResolvedValue([{ id: "pending", contactId: "contact-1", text: "Сколько стоит курс?", snapshotAt: new Date(), attempts: 0, delayNoticeAt: null, contact: fakeContact() }]);
    reply.mockRejectedValueOnce(new MetaDeliveryError(kind, 0));
    await retryPendingAiReplies();
    expect(db.model("pendingAiReply").delete).toHaveBeenCalledWith({ where: { id: "pending" } });
    expect(db.model("pendingAiReply").update).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
