import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({ getSetting: vi.fn(async (k: string) => store.get(k) ?? null) }));
vi.mock("../../src/dailyReport.js", () => ({ offsetMs: async () => 0 }));

import { renderFunnelText } from "../../src/funnelPlaceholders.js";
import { resetSalesTextsCache } from "../../src/services/salesTextsService.js";

beforeEach(() => {
  // Дата курса 20.11 уже в прошлом — без фиксации «сегодня» тест сам протухал (22.11.2026).
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:00:00Z") });
  resetSalesTextsCache();
  store.clear();
  store.set("offlineCourseStartDate", "2026-11-20");
  store.set("offlineCourseHours", "13:40–16:30");
});

afterEach(() => {
  vi.useRealTimers();
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
  it("ручная надпись offlineCourseDate больше не читается — дата одна (08.11.2026)", async () => {
    store.set("offlineCourseDate", "с 20 по 28 октября");
    expect(await renderFunnelText("Старт {дата}")).toBe("Старт 20 ноября");
  });
  it("прошедшая дата — «уточняется», а не прошлый набор", async () => {
    store.set("offlineCourseStartDate", "2020-01-10");
    expect(await renderFunnelText("Курс начнётся {дата}, записывайтесь")).toBe("Курс начнётся (дата уточняется), записывайтесь");
    expect(await renderFunnelText("Курси ояндамон {дата} сар мешавад, ҳамин шумо")).toBe("Курси ояндамон (сана ҳоло аниқ нест) сар мешавад, ҳамин шумо");
  });
  it("время не задано — часы по умолчанию из «Цены и даты», старая запись приводится к ЧЧ:ММ–ЧЧ:ММ", async () => {
    store.delete("offlineCourseHours");
    expect(await renderFunnelText("в {время}")).toBe("в 13:40–16:30");
    store.set("offlineCourseHours", "14:00 до 17:00");
    resetSalesTextsCache();
    expect(await renderFunnelText("в {время}")).toBe("в 14:00–17:00");
  });
});
