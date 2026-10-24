import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@prisma/client";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { queueUncheckedReceipt, retryUncheckedReceipts } from "../../src/receiptRetry.js";
import { retryPendingAiReplies } from "../../src/aiReplyRetry.js";
import { aiReplyToComment, registerOfflineIfAsked, rescueImage, rescueIncomingImages } from "../../src/ai.js";
import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { grantCourses } from "../../src/ai/grantCourses.js";
import { sendToContact } from "../../src/messaging/send.js";
import { withMessagingPermission } from "../../src/messaging/automation.js";
import { maybeRestoreAccess } from "../../src/course/recovery.js";

let db: PrismaMock;
const contact = fakeContact({ channel: "WEB" }) as unknown as Contact;
beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async (args) => {
    const key = (args as { where: { key: string } }).where.key;
    // Conflicting subordinate flags cannot override the master pause.
    return { value: ["botFrozen", "aiCommentRepliesEnabled", "qaAutoReplyEnabled"].includes(key) ? "true" : "" };
  });
});
afterEach(restorePrisma);

describe("funnel-only freeze", () => {
  it("preserves unchecked receipt and pending AI queues without consuming attempts", async () => {
    await retryUncheckedReceipts();
    await retryPendingAiReplies();
    expect(db.model("receiptCheck").findMany).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").update).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").findMany).not.toHaveBeenCalled();
    expect(db.model("pendingAiReply").update).not.toHaveBeenCalled();
  });

  it("does not consume selected receipt rows if the owner freezes after queue selection", async () => {
    let frozen = false;
    db.model("setting").findUnique.mockImplementation(async (args) => {
      const key = (args as { where: { key: string } }).where.key;
      return { value: key === "botFrozen" ? String(frozen) : "" };
    });
    db.model("receiptCheck").findMany.mockImplementation(async () => {
      frozen = true;
      return [{ id: "old-receipt", confidence: 2, imageUrl: null }];
    });
    await retryUncheckedReceipts();
    expect(db.model("receiptCheck").findMany).toHaveBeenCalledOnce();
    expect(db.model("receiptCheck").update).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").delete).not.toHaveBeenCalled();
  });

  it("refuses receipt intake and offline auto registration", async () => {
    expect(await queueUncheckedReceipt(contact.id, "hash", "/media/x.jpg")).toBeNull();
    expect(await rescueIncomingImages(contact, [{ kind: "image", url: "https://example.com/receipt" }])).toEqual([]);
    await expect(rescueImage(contact, Buffer.from("receipt"), "image/jpeg")).rejects.toThrow("Bot automation is frozen");
    expect(await registerOfflineIfAsked(contact, "офлайн 900123456")).toBe(false);
    expect(db.model("receiptCheck").create).not.toHaveBeenCalled();
  });

  it("cannot apply a previously started verdict or issue course access", async () => {
    await handleReceiptVerdict(contact, { kind: "valid", confidence: 1, amount: 70, receiptAt: new Date(), reason: "valid", imageHash: "hash", imageUrl: null }, "pending-1");
    expect(await grantCourses(contact, { grant: ["COURSE70"], note: "70" }, 70, { amount: 70 })).toEqual([]);
    expect(await maybeRestoreAccess(contact, "потеряла ссылку")).toEqual({ handled: false });
    expect(db.model("receiptCheck").update).not.toHaveBeenCalled();
    expect(db.model("purchase").create).not.toHaveBeenCalled();
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("comment AI stays silent even if its own toggle is enabled", async () => {
    await aiReplyToComment(contact, "comment-1", "расскажите о курсе");
    expect(db.model("message").create).not.toHaveBeenCalled();
  });

  it("allows funnel messages only inside their explicit outbound scope", async () => {
    await withMessagingPermission("funnel", () => sendToContact(contact, "Existing funnel step"));
    expect(db.model("message").create).toHaveBeenCalledOnce();
    await expect(sendToContact(contact, "AI outside funnel")).rejects.toThrow("Bot automation is frozen");
    expect(db.model("message").create).toHaveBeenCalledOnce();
  });
});
