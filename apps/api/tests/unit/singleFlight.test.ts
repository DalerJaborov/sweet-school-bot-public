import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma } from "../helpers.js";
import { singleFlight, inFlight, resetFlights } from "../../src/services/singleFlight.js";

beforeEach(() => {
  mockPrisma();
  resetFlights();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  restorePrisma();
});

/** Промис, который завершится только когда мы скажем. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("singleFlight — один прогон за раз с предохранителем", () => {
  it("пока идёт прогон, второй по тому же имени пропускается", async () => {
    const d = deferred();
    const first = singleFlight("x", () => d.promise);
    expect(await singleFlight("x", async () => undefined)).toBe(false);
    d.resolve();
    expect(await first).toBe(true);
    expect(inFlight()).toEqual([]);
  });

  it("разные имена не мешают друг другу", async () => {
    const d = deferred();
    void singleFlight("a", () => d.promise);
    expect(await singleFlight("b", async () => undefined)).toBe(true);
    d.resolve();
  });

  it("ГЛАВНОЕ: зависший прогон не блокирует задачу навсегда", async () => {
    // Раньше флаг busy оставался поднятым до перезапуска контейнера, а /health
    // был зелёный — тик-то крутился.
    const hung = deferred(); // никогда не резолвим
    void singleFlight("stuck", () => hung.promise);
    expect(await singleFlight("stuck", async () => undefined)).toBe(false);

    vi.advanceTimersByTime(11 * 60_000);

    const ran = vi.fn(async () => undefined);
    expect(await singleFlight("stuck", ran)).toBe(true);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("очнувшийся зависший прогон не сбрасывает флаг того, кто его заменил", async () => {
    const hung = deferred();
    const old = singleFlight("y", () => hung.promise);
    vi.advanceTimersByTime(11 * 60_000);
    const fresh = deferred();
    void singleFlight("y", () => fresh.promise);

    hung.resolve();
    await old;
    // Новый прогон всё ещё идёт — его флаг на месте.
    expect(inFlight().map((f) => f.name)).toEqual(["y"]);
    fresh.resolve();
  });

  it("ошибка внутри прогона снимает флаг — следующий тик снова работает", async () => {
    await expect(singleFlight("e", async () => { throw new Error("бум"); })).rejects.toThrow("бум");
    expect(await singleFlight("e", async () => undefined)).toBe(true);
  });
});
