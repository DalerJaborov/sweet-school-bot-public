import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma } from "../helpers.js";
import { sendText, sendAttachment, sendPrivateReply } from "../../src/instagram.js";
import { withMessagingPermission } from "../../src/messaging/automation.js";

let frozen = false;
beforeEach(() => {
  frozen = false;
  vi.useFakeTimers();
  const db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async (args) => {
    const key = (args as { where: { key: string } }).where.key;
    return { value: key === "botFrozen" ? String(frozen) : "test-token" };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restorePrisma();
});

describe("freeze at Meta transport", () => {
  it("cancels an in-flight reply when frozen during typing", async () => {
    const fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.sender_action === "typing_on") frozen = true;
      return new Response(JSON.stringify({ message_id: "mid-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = sendText("ig-1", "Reply prepared before freeze");
    const rejected = expect(pending).rejects.toThrow("Bot automation is frozen");
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, opts]) => !JSON.parse(opts.body).message)).toBe(true);
  });

  it("blocks private replies and attachments before any request", async () => {
    frozen = true;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(sendPrivateReply("comment-1", "AI")).rejects.toThrow("Bot automation is frozen");
    await expect(sendAttachment("ig-1", "https://example.com/a.jpg", "image")).rejects.toThrow("Bot automation is frozen");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("existing funnel private reply and explicit manual transport remain allowed", async () => {
    frozen = true;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message_id: "mid-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(withMessagingPermission("funnel", () => sendPrivateReply("comment-1", "Existing step"))).resolves.toBe("mid-1");
    await expect(withMessagingPermission("human", () => sendAttachment("ig-1", "https://example.com/a.jpg", "image"))).resolves.toBe("mid-1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
