import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContact, mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { assertMessagingAllowed, withContactMessaging, withMessagingPermission, withVerifiedReceiptDelivery } from "../../src/messaging/automation.js";

let db: PrismaMock;
let contact: ReturnType<typeof fakeContact>;
beforeEach(() => {
  db = mockPrisma();
  contact = fakeContact();
  db.model("contact").findUnique.mockImplementation(async () => contact);
  db.model("setting").findUnique.mockResolvedValue({ value: "false" });
});
afterEach(restorePrisma);
const normal = () => withContactMessaging("contact-1", "reply", assertMessagingAllowed);
const receipt = () => withVerifiedReceiptDelivery("contact-1", "hash", () =>
  withContactMessaging("contact-1", "verified_receipt_access", assertMessagingAllowed));

describe("fresh shared outbound policy", () => {
  it("cancels a prepared reply when a human takes over and keeps receipt-only permission narrow", async () => {
    await normal();
    contact.humanTakenOverAt = new Date();
    await expect(normal()).rejects.toThrow("contact policy");
    await expect(receipt()).resolves.toBeUndefined();
    await expect(normal()).rejects.toThrow("contact policy");
  });
  it.each(["personal", "spamBlockedAt", "whatsappSavedContact"])("hard block %s also stops a verified receipt", async (field) => {
    contact[field] = field === "spamBlockedAt" ? new Date() : true;
    await expect(normal()).rejects.toThrow("contact policy");
    await expect(receipt()).rejects.toThrow("contact policy");
  });
  it("cannot forge a receipt purpose or reuse another contact's receipt", async () => {
    await expect(withContactMessaging("contact-1", "verified_receipt_access", assertMessagingAllowed)).rejects.toThrow("unverified receipt");
    await expect(withVerifiedReceiptDelivery("other", "hash", () => withContactMessaging("contact-1", "verified_receipt_access", assertMessagingAllowed))).rejects.toThrow("unverified receipt");
  });
  it("global freeze dominates receipt exception, funnel permission never bypasses takeover", async () => {
    contact.humanTakenOverAt = new Date();
    await expect(withMessagingPermission("funnel", normal)).rejects.toThrow("contact policy");
    db.model("setting").findUnique.mockResolvedValue({ value: "true" });
    await expect(receipt()).rejects.toThrow("frozen");
  });
  it("explicit human operations remain possible", async () => {
    contact.personal = true;
    contact.humanTakenOverAt = new Date();
    await expect(withMessagingPermission("human", () => withContactMessaging("contact-1", "human", assertMessagingAllowed))).resolves.toBeUndefined();
  });
  it("fails closed for missing contact", async () => {
    db.model("contact").findUnique.mockResolvedValue(null);
    await expect(normal()).rejects.toThrow("missing contact");
  });
});
