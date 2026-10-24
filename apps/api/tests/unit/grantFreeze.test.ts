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
import { grantCourses } from "../../src/ai/grantCourses.js";

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

  it("explicit owner approval still grants manually while frozen", async () => {
    frozen = true;
    expect(await grantCourses(contact, plan, 70, { amount: 70 }, { byHuman: true })).toEqual(["COURSE70"]);
    expect(issueCourseLink).toHaveBeenCalledWith(contact.id, { automatic: false });
    expect(sendToContact).toHaveBeenCalledWith(contact, "Course access", [], { byHuman: true });
    expect(db.model("purchase").delete).not.toHaveBeenCalled();
  });
});
