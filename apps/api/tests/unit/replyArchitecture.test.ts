import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");

describe("generated reply boundaries", () => {
  it("keeps sales, lesson and panel replies behind the common policy", () => {
    expect(source("ai.ts")).toContain("replyPolicyIssues(replyText, facts)");
    expect(source("ai.ts")).toContain("replyPolicyIssues(result.text, await trustedSalesFacts())");
    expect(source("ai.ts")).not.toMatch(/sendPrivateReply\(commentId, result\.text/);
    expect(source("course/assistant.ts")).toContain("guardGeneratedTone(answer)");
    expect(source("assistantPanel.ts")).not.toContain("answer: result.text");
    expect(source("assistantPanel.ts")).toContain("guardGeneratedTone(result.text)");
  });
  it("does not apply sales-number filtering to lesson material or human sends", () => {
    expect(source("course/assistant.ts")).not.toContain("replyPolicyIssues(");
    expect(source("messaging/send.ts")).toContain("if (!opts.byHuman) text = await humanizeForContact(contact.id, cleanKeepingWarmTail(text))");
  });
  it("uses explicit structured Meta failures at the transport boundary", () => {
    expect(source("instagram.ts")).toContain("throw metaResponseError(res.status, text)");
    expect(source("instagram.ts")).toContain('new MetaDeliveryError("AMBIGUOUS", 0)');
    expect(source("instagram.ts")).not.toContain("for (let attempt = 0; attempt < 2;");
  });
});
