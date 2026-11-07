import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWithFallback } from "../../src/gemini.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Gemini empty responses are failures", () => {
  it("retries an empty response once, then preserves finish reason", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = generateWithFallback(["local-test"], "model", () => "{}", 60_000);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ error: expect.stringContaining("finish=STOP") });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reports a blocked response without trying to bypass the block", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })));
    vi.stubGlobal("fetch", fetcher);
    expect(await generateWithFallback(["local-test"], "model", () => "{}", 60_000)).toMatchObject({ error: expect.stringContaining("block=SAFETY") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains valid tool calls without text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] } }] }))));
    expect(await generateWithFallback(["local-test"], "model", () => "{}", 60_000)).toMatchObject({ text: null, functionCalls: [{ name: "lookup", args: {} }] });
  });
});
