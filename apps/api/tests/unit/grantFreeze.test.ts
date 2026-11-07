import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@prisma/client";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const { issueCourseLink, linkPurchaseToCourse, sendToContact } = vi.hoisted(() => ({
  issueCourseLink: vi.fn(), linkPurchaseToCourse: vi.fn(), sendToContact: vi.fn(),
}));
vi.mock("../../src/course/delivery.js", () => ({
  deliveryModeFor: async () => "web",
  coursePlatformReady: async () => true,
  issueCourseLink, linkPurchaseToCourse,
  accessMessage: () => "Course access",
}));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact }));
import { MetaDeliveryError } from "../../src/messaging/metaErrors.js";
import { grantCourses } from "../../src/ai/grantCourses.js";
import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";

let db: PrismaMock;
let frozen = false;
beforeEach(() => {
  frozen = false;
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async (args) => {
    const key = (args as { where: { key: string } }).where.key;
    return { value: key === "botFrozen" ? String(frozen) : "" };
  });
  db.model("purchase").create.mockResolvedValue({ id: "new-purchase-only" });
  db.model("purchase").count.mockResolvedValue(1);
  issueCourseLink.mockReset().mockResolvedValue("/course/new-link");
  linkPurchaseToCourse.mockReset().mockResolvedValue(undefined);
  sendToContact.mockReset().mockResolvedValue("mid-1");
});
afterEach(restorePrisma);

const contact = fakeContact({ channel: "WEB", paid: true }) as unknown as Contact;
const plan = { grant: ["COURSE70" as const], note: "70" };

describe("in-flight course grants", () => {
  it.each([undefined, "unchecked-original"])("incomplete screenshot %s cannot grant access even with high confidence", async (existingId) => {
    db.model("purchase").findMany.mockResolvedValue([]);
    db.model("receiptCheck").create.mockResolvedValue({ id: "review" });
    db.model("receiptCheck").update.mockResolvedValue({ id: "review" });
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    await handleReceiptVerdict(contact, {
      kind: "valid", confidence: 100, amount: 70, receiptAt: null,
      reason: "valid", imageHash: "original-hash", imageUrl: "/media/original.jpg",
    }, existingId);
    expect(db.model("purchase").create).not.toHaveBeenCalled();
    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(sendToContact.mock.calls.every((call) => !String(call[1]).includes("/l/"))).toBe(true);
    const saved = existingId ? db.model("receiptCheck").update : db.model("receiptCheck").create;
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "PENDING", linkSent: false }) }));
  });

  it("freeze during receipt save stops later alternative-screenshot side effects", async () => {
    db.model("receiptCheck").create.mockImplementation(async () => {
      frozen = true;
      return { id: "saved-before-freeze" };
    });
    await handleReceiptVerdict(contact, {
      kind: "suspicious", confidence: 30, amount: null, receiptAt: null,
      reason: "unclear", imageHash: "original-hash", imageUrl: "/media/original.jpg",
    });
    expect(db.model("receiptCheck").create).toHaveBeenCalledOnce();
    expect(db.model("contact").update).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });
  it("late token-issuance freeze rolls back only the new purchase", async () => {
    issueCourseLink.mockImplementation(async () => {
      frozen = true;
      throw new Error("Bot automation is frozen");
    });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(db.model("purchase").delete).toHaveBeenCalledExactlyOnceWith({ where: { id: "new-purchase-only" } });
    expect(db.model("purchase").deleteMany).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("freeze after purchase creation blocks issuance and preserves prior access", async () => {
    linkPurchaseToCourse.mockImplementation(async () => { frozen = true; });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(issueCourseLink).not.toHaveBeenCalled();
    expect(db.model("purchase").delete).toHaveBeenCalledExactlyOnceWith({ where: { id: "new-purchase-only" } });
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("network failure keeps paid purchase pending, and retry reuses it", async () => {
    sendToContact.mockRejectedValueOnce(new Error("network unavailable"));
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(db.model("purchase").delete).not.toHaveBeenCalled();
    expect(db.model("purchase").deleteMany).not.toHaveBeenCalled();
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { paid: true, paidAt: expect.any(Date) } }));
    db.model("purchase").findUnique.mockResolvedValue({ id: "new-purchase-only", inviteLink: null, revokedAt: null });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual(["COURSE70"]);
    expect(db.model("purchase").create).toHaveBeenCalledTimes(1);
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { inviteLink: "/course/new-link" } }));
  });

  it("retry never revives a revoked purchase", async () => {
    db.model("purchase").findUnique.mockResolvedValue({ id: "old", inviteLink: null, revokedAt: new Date() });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("purchase").create).not.toHaveBeenCalled();
  });

  it("a late freeze at transport rolls back only purchases created in this call", async () => {
    sendToContact.mockImplementationOnce(async () => { frozen = true; throw new Error("Bot automation is frozen"); });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(db.model("purchase").deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["new-purchase-only"] } } });
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });

  it("ambiguous delivery is recorded and cannot be silently resent", async () => {
    sendToContact.mockRejectedValueOnce(new MetaDeliveryError("AMBIGUOUS", 0));
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith({ where: { id: { in: ["new-purchase-only"] } }, data: { accessDeliveryUncertainAt: expect.any(Date) } });
    db.model("purchase").findUnique.mockResolvedValue({ id: "new-purchase-only", inviteLink: null, accessDeliveryUncertainAt: new Date() });
    expect(await grantCourses(contact, plan, 70, { amount: 70 })).toEqual([]);
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });

  it("explicit owner approval still grants manually while frozen", async () => {
    frozen = true;
    expect(await grantCourses(contact, plan, 70, { amount: 70 }, { byHuman: true })).toEqual(["COURSE70"]);
    expect(issueCourseLink).toHaveBeenCalledWith(contact.id, { automatic: false, preserveExisting: true });
    expect(sendToContact).toHaveBeenCalledWith(contact, "Course access", [], { byHuman: true });
    expect(db.model("purchase").delete).not.toHaveBeenCalled();
  });
});
