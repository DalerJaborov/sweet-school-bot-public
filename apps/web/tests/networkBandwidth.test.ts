import { describe, it, expect, beforeEach } from "vitest";
import { loadBandwidth, saveBandwidth } from "../src/course/player/network";

/** Память о скорости канала: только стартовая оценка, мусор и старьё не берём. */
describe("loadBandwidth / saveBandwidth", () => {
  const now = 1_800_000_000_000;
  beforeEach(() => localStorage.clear());

  it("сохранённое значение читается обратно (округлено)", () => {
    saveBandwidth(1_234_567.8, now);
    expect(loadBandwidth(now + 1000)).toBe(1_234_568);
  });
  it("старше недели — не берём", () => {
    saveBandwidth(2_000_000, now);
    expect(loadBandwidth(now + 8 * 86_400_000)).toBeNull();
  });
  it("из будущего (сбитые часы) — не берём", () => {
    saveBandwidth(2_000_000, now + 60_000);
    expect(loadBandwidth(now)).toBeNull();
  });
  it("вне границ и NaN не сохраняются", () => {
    saveBandwidth(50_000, now);
    saveBandwidth(Number.NaN, now);
    saveBandwidth(500_000_000, now);
    expect(localStorage.getItem("ssb_bw")).toBeNull();
  });
  it("мусор в хранилище — null, без исключения", () => {
    localStorage.setItem("ssb_bw", "{not json");
    expect(loadBandwidth(now)).toBeNull();
    localStorage.setItem("ssb_bw", JSON.stringify({ bps: "fast", at: now }));
    expect(loadBandwidth(now)).toBeNull();
  });
});
