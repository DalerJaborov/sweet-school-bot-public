import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma } from "../helpers.js";
const generate = vi.fn();
vi.mock("../../src/gemini.js", () => ({ generateWithFallback: (...args: unknown[]) => generate(...args), thinkingConfigFor: () => ({}) }));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: async () => ["local-test"] }));
import { answerFromRecipes } from "../../src/course/assistant.js";

beforeEach(() => {
  const db = mockPrisma();
  db.model("course").findUnique.mockResolvedValue({ title: "Курс", modules: [{ lessons: [{ id: "lesson", title: "Эклер", recipeText: "200 г муки, 180 градусов", transcript: null }] }] });
  db.model("setting").findUnique.mockResolvedValue(null);
  generate.mockReset();
});
afterEach(restorePrisma);

describe("lesson replies preserve ingredients and formal tone", () => {
  it("leaves recipe quantities unchanged", async () => {
    generate.mockResolvedValue({ text: "Добавьте 200 г муки и выпекайте при 180 градусах" });
    expect(await answerFromRecipes("course", "Сколько муки?", "ru", "lesson")).toEqual({ text: "Добавьте 200 г муки и выпекайте при 180 градусах" });
    expect(generate.mock.calls[0][3]).toBe(25_000);
  });
  it("holds an informal answer so the caller can ask the teacher", async () => {
    generate.mockResolvedValue({ text: "Ты добавь 200 г муки" });
    expect(await answerFromRecipes("course", "Сколько муки?", "ru", "lesson")).toEqual({ text: null, reason: "unavailable" });
  });
  it("does not pretend a provider failure means a missing recipe", async () => {
    generate.mockResolvedValue({ error: "empty response" });
    expect(await answerFromRecipes("course", "Сколько муки?", "ru", "lesson")).toEqual({ text: null, reason: "unavailable" });
  });
});
