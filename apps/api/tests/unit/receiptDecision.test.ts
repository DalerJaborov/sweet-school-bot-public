import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

vi.mock("../../src/instagram.js", () => ({
  sendText: vi.fn(async () => "mid-1"),
  channelOf: () => "INSTAGRAM",
}));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/ai.js", () => ({ grantCourses: vi.fn(async () => ["COURSE70"]) }));
vi.mock("../../src/courses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/courses.js")>()),
  allocate: vi.fn(async () => ({ grant: ["COURSE70"], note: "70 сомони", discounted: false })),
  ownedCourses: vi.fn(async () => []),
}));

import { sendText } from "../../src/instagram.js";
import { grantCourses } from "../../src/ai.js";
import { allocate, ownedCourses } from "../../src/courses.js";
import { decideReceipt } from "../../src/receiptDecision.js";

function receipt(overrides: Record<string, unknown> = {}) {
  const contact = fakeContact();
  return {
    id: "receipt-1",
    contactId: contact.id,
    contact,
    amount: 70,
    reason: "похож на настоящий",
    ownerDecision: "PENDING",
    ...overrides,
  };
}

describe("decideReceipt", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("сумма не прочиталась и курс не выбран — needs_course, база не тронута", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt({ amount: null }));

    const result = await decideReceipt("receipt-1", "approve");

    expect(result).toMatchObject({ ok: false, reason: "needs_course" });
    expect(db.model("receiptCheck").updateMany).not.toHaveBeenCalled();
  });

  it("второй тап по уже решённому чеку — already_decided, без повторной отправки", async () => {
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 0 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt({ ownerDecision: "APPROVED" }));

    const result = await decideReceipt("receipt-1", "reject");

    expect(result).toMatchObject({ ok: false, reason: "already_decided" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("отклонение: клиенту уходит вежливый отказ и он ложится в историю", async () => {
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt());

    const result = await decideReceipt("receipt-1", "reject");

    expect(result).toMatchObject({ ok: true, status: "rejected" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(db.model("message").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: "contact-1", direction: "OUT" }) })
    );
    expect(grantCourses).not.toHaveBeenCalled();
  });

  it("подтверждение с прочитанной суммой: раскладка по сумме, доступ выдан, «оплатил» проставлен", async () => {
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt({ amount: 70 }));

    const result = await decideReceipt("receipt-1", "approve");

    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect(allocate).toHaveBeenCalledWith("contact-1", 70);
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(db.model("contact").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "contact-1", paid: false } })
    );
    expect(db.model("receiptCheck").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerDecision: "APPROVED", linkSent: true }) })
    );
  });

  it("сумма не прочиталась, владелец выбрал курс явно — цена берётся из прайса, не угадывается", async () => {
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt({ amount: null }));

    const result = await decideReceipt("receipt-1", "approve", "COURSE50");

    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect(allocate).not.toHaveBeenCalled();
    expect(ownedCourses).toHaveBeenCalledWith("contact-1");
    expect(grantCourses).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grant: ["COURSE50"] }),
      50,
      { amount: null, currency: "TJS" },
      { byHuman: true }
    );
  });

  it("всё уже куплено — ссылка не отправляется, но решение записано", async () => {
    vi.mocked(ownedCourses).mockResolvedValueOnce(["COURSE50", "COURSE70"]);
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt({ amount: null }));

    const result = await decideReceipt("receipt-1", "approve", "BOTH");

    expect(result).toMatchObject({ ok: true, status: "approved_no_link" });
    expect(grantCourses).not.toHaveBeenCalled();
  });

  it("группа/ссылка доступа не настроены — честная ошибка, а не «подтверждено»", async () => {
    vi.mocked(grantCourses).mockResolvedValueOnce([]);
    db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
    db.model("receiptCheck").findUnique.mockResolvedValue(receipt());

    const result = await decideReceipt("receipt-1", "approve");

    expect(result).toMatchObject({ ok: false, reason: "no_access_configured" });
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
});
