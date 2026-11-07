import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaResponseError, canRetryMetaFailure, MetaDeliveryError } from "../../src/messaging/metaErrors.js";
import { sendText, sendAttachment } from "../../src/instagram.js";
import { mockPrisma, restorePrisma } from "../helpers.js";

describe("Meta failure decisions", () => {
  it.each([
    [400, { code: 190 }, "TOKEN", false],
    [400, { code: 10, error_subcode: 2018278 }, "WINDOW", false],
    [429, { code: 613 }, "RATE", true],
    [503, {}, "TRANSIENT", true],
    [400, { code: 100 }, "PERMANENT", false],
  ] as const)("classifies %i %j", (status, details, kind, retry) => {
    const error = metaResponseError(status, JSON.stringify({ error: { ...details, message: "secret-token" } }));
    expect(error.kind).toBe(kind);
    expect(canRetryMetaFailure(error)).toBe(retry);
    expect(error.message).not.toContain("secret-token");
  });
});

describe("ambiguous Meta sends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const db = mockPrisma();
    db.model("setting").findUnique.mockImplementation(async (args) => ({ value: (args as any).where.key === "botFrozen" ? "false" : "test-token" }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); restorePrisma(); });
  it.each(["text", "attachment"])("does not retry accepted-but-disconnected %s", async (kind) => {
    const sends: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.sender_action) return new Response("{}");
      sends.push(body);
      throw new TypeError("fetch failed");
    }));
    const result = (kind === "text" ? sendText("123", "Здравствуйте") : sendAttachment("123", "https://example.com/a.jpg")).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(MetaDeliveryError);
    expect((await result).kind).toBe("AMBIGUOUS");
    expect(canRetryMetaFailure(await result)).toBe(false);
    expect(sends).toHaveLength(1);
  });
  it.each(["", "{}", "not-json"])("holds a success response without delivery ID: %s", async (body) => {
    const fetcher = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(sendAttachment("123", "https://example.com/a.jpg")).rejects.toMatchObject({ kind: "AMBIGUOUS" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
