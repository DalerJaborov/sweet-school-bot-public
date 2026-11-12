import { beforeEach, describe, expect, it } from "vitest";
import type { CourseInfo } from "../src/course/api";
import { mayPrefetch, loadBandwidth, nextLessonOf, playLocalFirst, saveBandwidth } from "../src/course/speed";

const lesson = (id: string, ready = true) => ({ id, ready }) as never;
const course = (ids: [string, boolean][]) =>
  ({ modules: [{ lessons: ids.map(([id, ready]) => lesson(id, ready)) }] }) as unknown as CourseInfo;

describe("speed: скорость канала", () => {
  beforeEach(() => localStorage.clear());

  it("запоминает и возвращает свежую оценку", () => {
    saveBandwidth(2_400_000, 1000);
    expect(loadBandwidth(2000)).toBe(2_400_000);
  });
  it("старше недели и мусор не берём", () => {
    saveBandwidth(2_400_000, 1000);
    expect(loadBandwidth(1000 + 8 * 86_400_000)).toBeNull();
    saveBandwidth(5, 1000);
    saveBandwidth(Number.NaN, 1000);
    localStorage.setItem("ssb_bw", "{oops");
    expect(loadBandwidth(1500)).toBeNull();
  });
});

describe("speed: из памяти телефона при интернете", () => {
  const ok = { fast: true, saved: true, swControlled: true, failed: false, authorized: true };
  it("играет локально только когда всё условия есть", () => {
    expect(playLocalFirst(ok)).toBe(true);
    expect(playLocalFirst({ ...ok, authorized: false })).toBe(false);
    expect(playLocalFirst({ ...ok, fast: false })).toBe(false);
    expect(playLocalFirst({ ...ok, saved: false })).toBe(false);
    expect(playLocalFirst({ ...ok, swControlled: false })).toBe(false);
    expect(playLocalFirst({ ...ok, failed: true })).toBe(false);
  });
});

describe("speed: следующий урок", () => {
  it("пропускает неготовые и не выходит за курс", () => {
    const c = course([["a", true], ["b", false], ["c", true]]);
    expect(nextLessonOf([c], "a")?.id).toBe("c");
    expect(nextLessonOf([c], "c")).toBeNull();
    expect(nextLessonOf([c], "zzz")).toBeNull();
  });
});


describe("background transfer policy", () => {
  it("never prefetches the next lesson on an unknown connection or cellular", () => {
    for (const connection of [undefined, { effectiveType: "4g" }, { effectiveType: "4g", type: "cellular" }, { type: "wifi", effectiveType: "4g", saveData: true }]) {
      Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
      expect(mayPrefetch(true)).toBe(false);
    }
    Object.defineProperty(navigator, "connection", { configurable: true, value: { type: "wifi", effectiveType: "4g", saveData: false } });
    expect(mayPrefetch(true)).toBe(true);
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
  });
});
