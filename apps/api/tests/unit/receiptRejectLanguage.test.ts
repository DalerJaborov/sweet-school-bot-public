import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async () => "mid-1");
vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: () => "instagram",
}));
vi.mock("../../src/ai.js", () => ({ grantCourses: vi.fn() }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));

import { decideReceipt } from "../../src/receiptDecision.js";

let db: PrismaMock;

beforeEach(() => {
  db = mockPrisma();
  db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
  db.model("receiptCheck").findUnique.mockResolvedValue({
    id: "r1",
    contactId: "c1",
    ownerDecision: "REJECTED",
    contact: fakeContact({ id: "c1" }),
  });
  sendText.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

/**
 * Отказ по чеку уходил ТОЛЬКО на таджикском. Русскоязычная клиентка читала
 * непонятный текст и уходила вместо того, чтобы прислать нормальный чек.
 */
describe("Отказ по чеку — на языке клиентки", () => {
  it("последнее сообщение по-русски — отказ по-русски", async () => {
    db.model("message").findFirst.mockResolvedValue({ text: "Я оплатила, вот чек" });
    const result = await decideReceipt("r1", "reject");
    expect(result).toMatchObject({ ok: true, status: "rejected" });
    expect(String(sendText.mock.calls[0][1])).toContain("оплату пока не удалось подтвердить");
  });

  it("по-таджикски — как и раньше, по-таджикски", async () => {
    db.model("message").findFirst.mockResolvedValue({ text: "Ман пардохт кардам, апачон" });
    await decideReceipt("r1", "reject");
    expect(String(sendText.mock.calls[0][1])).toContain("пардохт ҳоло тасдиқ нашуд");
  });

  it("истории нет — язык школы по умолчанию, таджикский", async () => {
    db.model("message").findFirst.mockResolvedValue(null);
    await decideReceipt("r1", "reject");
    expect(String(sendText.mock.calls[0][1])).toContain("пардохт ҳоло тасдиқ нашуд");
  });
});
