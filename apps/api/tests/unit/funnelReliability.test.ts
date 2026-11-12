import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, fakeFunnel, fakeStep, type PrismaMock } from "../helpers.js";
import type { Contact } from "@prisma/client";
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "sent"), sendAttachmentToContact: vi.fn() }));
vi.mock("../../src/instagram.js", () => ({ sendPrivateReply: vi.fn(), replyToComment: vi.fn(), deleteComment: vi.fn(), metaChannelOf: () => "INSTAGRAM", mediaPermalink: vi.fn() }));
vi.mock("../../src/ai.js", () => ({ aiReplyToComment: vi.fn(async () => undefined) }));
vi.mock("../../src/systemAlerts.js", () => ({ notifyFunnelGaveUp: vi.fn() }));
import { handleQuickReply, handleComment } from "../../src/funnel.js";
import { sendToContact } from "../../src/messaging/send.js";
import { aiReplyToComment } from "../../src/ai.js";
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";
import { notifyFunnelGaveUp } from "../../src/systemAlerts.js";
import * as database from "../../src/db.js";

let db: PrismaMock;
const contact = fakeContact() as unknown as Contact;
const input = { commentId: "comment", mediaId: "post", igUserId: "customer", username: null, text: "сколько стоит?" };
beforeEach(() => {
  vi.clearAllMocks(); db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("funnelStep").findUnique.mockResolvedValue({ ...fakeStep({ order: 2, delaySeconds: 0 }), funnel: fakeFunnel() });
  db.model("delivery").findUnique.mockResolvedValue({ id: "delivery", state: "WAITING", failCount: 0, nextOrder: 1, contactId: contact.id, contact });
  db.model("delivery").updateMany.mockResolvedValue({ count: 1 });
  db.model("funnel").findMany.mockResolvedValue([]);
  db.model("contact").upsert.mockResolvedValue(contact);
});
afterEach(() => { restorePrisma(); vi.restoreAllMocks(); });

describe("funnel reliability", () => {
  it("retries the selected button target, not the previous step, after a transient failure", async () => {
    vi.mocked(sendToContact).mockRejectedValueOnce(new Error("network unavailable"));
    await handleQuickReply(contact, "step:funnel-1:2");
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextOrder: 2, nextRunAt: expect.any(Date) }) }));
    // Условная запись (ревью 11.11.2026): отменённую за время отправки цепочку повтор не воскрешает.
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "delivery", state: "ACTIVE" }, data: expect.objectContaining({ state: "ACTIVE", failCount: 1, nextRunAt: expect.any(Date) }) }));
  });
  it("sends a clear response to an old completed button", async () => {
    db.model("delivery").findUnique.mockResolvedValue({ id: "delivery", state: "DONE", contact });
    db.model("delivery").updateMany.mockResolvedValue({ count: 0 });
    await handleQuickReply(contact, "step:funnel-1:2");
    expect(sendToContact).toHaveBeenCalledWith(contact, expect.stringContaining("больше не активна"));
  });
  it("does not retry a closed messaging window", async () => {
    vi.mocked(sendToContact).mockRejectedValueOnce(new MetaDeliveryError("WINDOW", 400));
    await handleQuickReply(contact, "step:funnel-1:2");
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: "ACTIVE" }), data: expect.objectContaining({ state: "FAILED", nextRunAt: null }) }));
    expect(notifyFunnelGaveUp).toHaveBeenCalled();
  });
  it("does not mark a failed comment as seen and processes the redelivery", async () => {
    vi.mocked(aiReplyToComment).mockRejectedValueOnce(new Error("failed"));
    await expect(handleComment(input)).rejects.toThrow("failed");
    expect(db.model("seenComment").create).not.toHaveBeenCalled();
    await handleComment(input);
    expect(aiReplyToComment).toHaveBeenCalledTimes(2);
    expect(db.model("seenComment").create).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent deliveries of the same comment", async () => {
    await Promise.all([handleComment(input), handleComment(input)]);
    expect(aiReplyToComment).toHaveBeenCalledTimes(1);
    expect(db.model("seenComment").create).toHaveBeenCalledTimes(1);
  });
});
