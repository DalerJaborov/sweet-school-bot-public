import { describe, expect, it } from "vitest";
import { buildInstruction, parseVerdict } from "../../src/ai/receiptCheck.js";

describe("receipt evidence", () => {
  it("requires an explicit OCR recipient match, never infers it from confidence", () => {
    const result = parseVerdict(JSON.stringify({ kind: "valid", confidence: 100, amount: 70, currency: "TJS", receiptAt: "2026-11-08T12:30:00" }));
    expect(result?.recipientMatches).toBe(false);
    expect(result?.receiptAt).toBeInstanceOf(Date);
  });
  it("does not invent a missing receipt time", () => {
    expect(parseVerdict(JSON.stringify({ kind: "valid", recipientMatches: true, receiptAt: "2026-11-08" }))?.receiptAt).toBeNull();
  });
  it("asks OCR for a readable recipient match and does not allow cropped details as valid", () => {
    const prompt = buildInstruction();
    expect(prompt).toContain("recipientMatches=false");
    expect(prompt).toContain("recipientMatches=true");
    expect(prompt).not.toContain("но в целом похож на настоящий перевод");
  });
});
