import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { debounceMessage, flushAllPending } from "../../src/debounce.js";
import * as database from "../../src/db.js";
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(database, "logError").mockImplementation(() => {}); });
afterEach(async () => { await flushAllPending(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps every merged inbox event pending until the combined reply finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reply = vi.fn(async () => gate);
  const first = debounceMessage("person", "one", [], [], reply);
  const second = debounceMessage("person", "two", [], [], reply);
  let done = 0; void first.then(() => done++); void second.then(() => done++);
  await vi.advanceTimersByTimeAsync(2500);
  expect(reply).toHaveBeenCalledWith("one\ntwo", [], []);
  expect(done).toBe(0);
  release(); await Promise.all([first, second]);
  expect(done).toBe(2);
});

it("returns failure to the durable inbox instead of logging and acknowledging lost work", async () => {
  const completion = debounceMessage("person", "one", [], [], async () => { throw new Error("not delivered"); });
  const assertion = expect(completion).rejects.toThrow("not delivered");
  await vi.advanceTimersByTimeAsync(2500);
  await assertion;
});
