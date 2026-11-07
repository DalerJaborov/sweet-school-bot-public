import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { recordOutgoingMessage } from "../../src/db.js";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
let db: PrismaMock;
const at = new Date();
beforeEach(() => {
  db = mockPrisma();
  db.model("message").create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "5" }));
  db.model("message").findUnique.mockResolvedValue({ contactId: "c", byHuman: true });
});
afterEach(restorePrisma);
describe("own outgoing echo recovery", () => {
  it("does not clear a takeover attributed to a different human message", async () => {
    db.model("contact").findUnique.mockResolvedValue({ humanTakeoverMid: "real-human", humanTakenOverAt: at });
    await recordOutgoingMessage("c", "bot", "own-mid");
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
  });
  it("clears only the exact own mid and preserves a later human reply", async () => {
    db.model("contact").findUnique.mockResolvedValue({ humanTakeoverMid: "own-mid", humanTakenOverAt: at });
    const later = new Date(at.getTime() + 1);
    db.model("message").findFirst.mockResolvedValue({ mid: "real-human", createdAt: later });
    await recordOutgoingMessage("c", "bot", "own-mid");
    expect(db.model("contact").updateMany).toHaveBeenCalledWith({
      where: { id: "c", humanTakeoverMid: "own-mid" }, data: { humanTakenOverAt: later, humanTakeoverMid: "real-human" },
    });
  });
  it("never repairs another contact's message", async () => {
    db.model("message").findUnique.mockResolvedValue({ contactId: "other", byHuman: true });
    await recordOutgoingMessage("c", "bot", "own-mid");
    expect(db.model("message").update).not.toHaveBeenCalled();
  });
});
