import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../../src/services/rateLimit.js";

describe("createRateLimiter — скользящее окно", () => {
  it("пропускает limit запросов, дальше 429 с retryAfterSec", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 10_000, now: () => t });
    expect(limiter.hit("a")).toEqual({ ok: true });
    expect(limiter.hit("a")).toEqual({ ok: true });
    expect(limiter.hit("a")).toEqual({ ok: true });
    const blocked = limiter.hit("a");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(10);
    // Другой ключ — свой счётчик.
    expect(limiter.hit("b")).toEqual({ ok: true });
  });

  it("окно скользит: спустя windowMs после самой старой отметки — снова можно", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 10_000, now: () => t });
    limiter.hit("a");
    t = 4_000;
    limiter.hit("a");
    t = 9_000;
    const blocked = limiter.hit("a");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(1); // первая отметка (t=0) уйдёт в 10 000
    t = 10_001;
    expect(limiter.hit("a")).toEqual({ ok: true });
    // Вторая (t=4000) ещё в окне, третья — только что: снова упор.
    expect(limiter.hit("a").ok).toBe(false);
  });

  it("reset забывает всё", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.hit("a");
    expect(limiter.hit("a").ok).toBe(false);
    limiter.reset();
    expect(limiter.hit("a").ok).toBe(true);
  });
});
