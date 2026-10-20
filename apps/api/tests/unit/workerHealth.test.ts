import { describe, it, expect, beforeEach } from "vitest";
import { markWorkerOk, markWorkerTimeout, stuckWorkers, resetWorkerHealth, STUCK_AFTER } from "../../src/workerHealth.js";

beforeEach(resetWorkerHealth);

describe("workerHealth — зависшая задача видна снаружи", () => {
  it("один-два тайм-аута — шум, не тревога", () => {
    expect(markWorkerTimeout("receiptRetry")).toBe(false);
    expect(markWorkerTimeout("receiptRetry")).toBe(false);
    expect(stuckWorkers()).toEqual([]);
  });

  it("ГЛАВНОЕ: третий подряд — тревога ровно один раз, и задача в списке зависших", () => {
    for (let i = 1; i < STUCK_AFTER; i++) markWorkerTimeout("joinReminder");
    expect(markWorkerTimeout("joinReminder")).toBe(true); // порог достигнут впервые
    expect(markWorkerTimeout("joinReminder")).toBe(false); // дальше молчим — не долбим
    expect(stuckWorkers()).toEqual([{ name: "joinReminder", timeouts: STUCK_AFTER + 1 }]);
  });

  it("успешный прогон обнуляет счётчик — ложная тревога от медленного Gemini не копится", () => {
    markWorkerTimeout("profiles");
    markWorkerTimeout("profiles");
    markWorkerOk("profiles");
    expect(markWorkerTimeout("profiles")).toBe(false);
    expect(stuckWorkers()).toEqual([]);
  });

  it("задачи считаются независимо", () => {
    for (let i = 0; i < STUCK_AFTER; i++) markWorkerTimeout("a");
    markWorkerTimeout("b");
    expect(stuckWorkers().map((w) => w.name)).toEqual(["a"]);
  });
});
