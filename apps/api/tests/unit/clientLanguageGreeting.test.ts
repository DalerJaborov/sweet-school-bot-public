import { describe, it, expect } from "vitest";
import { detectClientLanguage, languageSignal, conversationLanguage } from "../../src/ai/clientLanguage.js";

/** Владелец 08.11.2026: «Салом» пишут и русскоязычные, одно приветствие язык не определяет. */
describe("язык клиента: приветствие не переключает язык", () => {
  it("«Салом, сколько стоит онлайн» — русский", () => {
    expect(detectClientLanguage("Салом, сколько стоит онлайн")).toBe("ru");
    expect(detectClientLanguage("Ассалом, подскажите цену")).toBe("ru");
    expect(detectClientLanguage("Рахмат, понятно")).toBe("ru");
  });
  it("«Салом апачон курс чанд пул» — таджикский", () => {
    expect(detectClientLanguage("Салом апачон курс чанд пул")).toBe("tg");
  });
  it("пустой текст (голосовое WhatsApp) — не таджикский по умолчанию", () => {
    expect(detectClientLanguage("")).toBe("ru");
    expect(languageSignal("")).toBeNull();
  });
  it("одно приветствие или «спасибо» — языка нет, решает прошлая переписка", () => {
    for (const t of ["Салом", "Ассалому алейкум!", "Рахмат", "Бале", "Салом апа"]) expect(languageSignal(t)).toBeNull();
    expect(conversationLanguage(["Салом", "Курс чанд пул?"])).toBe("tg");
    expect(conversationLanguage(["Рахмат", "Сколько стоит курс?"])).toBe("ru");
    expect(conversationLanguage(["Салом"])).toBe("ru");
  });
});
