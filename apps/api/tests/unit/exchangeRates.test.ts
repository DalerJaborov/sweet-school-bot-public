import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async () => null),
  logError: vi.fn(),
}));

import { getSetting } from "../../src/db.js";
import { toSomoni, invalidateRateCache } from "../../src/exchangeRates.js";

const PRIMARY_OK = { ok: true, json: async () => ({ result: "success", rates: { RUB: 9.09, USD: 0.0943 } }) };
const PRIMARY_DOWN = { ok: false, json: async () => ({}) };
const BACKUP_OK = { ok: true, json: async () => ({ rub: { code: "RUB", rate: "10" } }) };
const BACKUP_DOWN = { ok: false, json: async () => ({}) };

const fetchMock = vi.fn();

describe("toSomoni", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:00:00Z"));
    invalidateRateCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("сомони и пустая валюта возвращаются как есть, без сети", async () => {
    expect(await toSomoni(70, null)).toBe(70);
    expect(await toSomoni(70, "TJS")).toBe(70);
    expect(await toSomoni(70, " сомони ")).toBe(70);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ручной курс из настроек важнее сети", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => (key === "rateRUB" ? "10" : null));

    expect(await toSomoni(700, "rub")).toBe(70);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("основной источник отвечает — считаем по нему и кэшируем", async () => {
    fetchMock.mockResolvedValue(PRIMARY_OK);

    expect(await toSomoni(909, "RUB")).toBeCloseTo(100, 5);
    expect(await toSomoni(909, "RUB")).toBeCloseTo(100, 5);
    // Второй перевод — из кэша: полсуток курс живёт без похода в сеть.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("основной молчит — берём запасной (он отдаёт «сомони за единицу», перевёрнуто)", async () => {
    fetchMock.mockResolvedValueOnce(PRIMARY_DOWN).mockResolvedValueOnce(BACKUP_OK);

    expect(await toSomoni(100, "RUB")).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("оба источника молчат и кэша нет — null, чек уходит владельцу, а не отвергается", async () => {
    fetchMock.mockResolvedValue(PRIMARY_DOWN);

    expect(await toSomoni(100, "RUB")).toBeNull();
  });

  it("незнакомая валюта — null даже при живом курсе", async () => {
    fetchMock.mockResolvedValue(PRIMARY_OK);

    expect(await toSomoni(100, "XYZ")).toBeNull();
  });

  it("сеть упала после удачного ответа — кэш до 48 часов ещё годится", async () => {
    fetchMock.mockResolvedValueOnce(PRIMARY_OK);
    expect(await toSomoni(909, "RUB")).toBeCloseTo(100, 5);

    vi.setSystemTime(new Date("2026-09-04T08:00:00Z")); // +24ч: кэш протух, сеть недоступна
    fetchMock.mockRejectedValue(new Error("network down"));
    expect(await toSomoni(909, "RUB")).toBeCloseTo(100, 5);
  });

  it("кэш старше 48 часов не используется — это деньги", async () => {
    fetchMock.mockResolvedValueOnce(PRIMARY_OK);
    expect(await toSomoni(909, "RUB")).toBeCloseTo(100, 5);

    vi.setSystemTime(new Date("2026-09-05T09:00:00Z")); // +49ч
    fetchMock.mockRejectedValue(new Error("network down"));
    expect(await toSomoni(909, "RUB")).toBeNull();
  });

  it("invalidateRateCache заставляет сходить в сеть заново", async () => {
    fetchMock.mockResolvedValue(PRIMARY_OK);
    await toSomoni(1, "RUB");
    invalidateRateCache();
    await toSomoni(1, "RUB");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
