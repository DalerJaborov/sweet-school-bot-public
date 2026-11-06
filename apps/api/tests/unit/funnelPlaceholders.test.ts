import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({ getSetting: vi.fn(async (k: string) => store.get(k) ?? null) }));
vi.mock("../../src/dailyReport.js", () => ({ offsetMs: async () => 0 }));

import { renderFunnelText } from "../../src/funnelPlaceholders.js";

beforeEach(() => {
  store.clear();
  store.set("offlineCourseStartDate", "2026-11-20");
  store.set("offlineCourseHours", "13:40–16:30");
});

describe("renderFunnelText", () => {
  it("текст без подстановок не меняется", async () => {
    expect(await renderFunnelText("Салом 20 ноябр")).toBe("Салом 20 ноябр");
  });
  it("таджикский текст получает «20 ноябр», время — из настройки", async () => {
    const out = await renderFunnelText("Курси ояндамон {дата} сар мешавад, соати {время} ҳамин шумо");
    expect(out).toBe("Курси ояндамон 20 ноябр сар мешавад, соати 13:40–16:30 ҳамин шумо");
  });
  it("русский текст получает «20 ноября»", async () => {
    expect(await renderFunnelText("Курс начнётся {дата}, вы можете записаться")).toContain("20 ноября");
  });
  it("ручная надпись из настроек важнее вычисленной", async () => {
    store.set("offlineCourseDate", "с 20 по 28 ноября");
    expect(await renderFunnelText("Старт {дата}")).toBe("Старт с 20 по 28 ноября");
  });
  it("время не задано — честная заглушка, а не пустое место", async () => {
    store.delete("offlineCourseHours");
    expect(await renderFunnelText("в {время}")).toBe("в время уточняется");
  });
});
