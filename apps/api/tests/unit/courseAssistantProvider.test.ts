import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma } from "../helpers.js";

const provider = vi.hoisted(() => vi.fn());
const logCall = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/gemini.js", () => ({ generateWithFallback: provider, thinkingConfigFor: () => ({ thinkingLevel: "minimal" }) }));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: async () => ["test-key"] }));
vi.mock("../../src/ai/aiLog.js", () => ({ logAiCall: logCall }));
import { answerFromRecipes } from "../../src/course/assistant.js";

describe("course assistant uses the common provider", () => {
  beforeEach(() => {
    provider.mockReset();
    logCall.mockClear();
    const db = mockPrisma();
    db.model("setting").findUnique.mockResolvedValue(null);
    db.model("course").findUnique.mockResolvedValue({ title: "Крем", modules: [{ lessons: [{ id: "l", title: "Крем", recipeText: "Сливки 33 процента, 200 грамм." }] }] });
  });
  afterEach(restorePrisma);
  it("passes one total deadline, isolates data from rules and logs the provider result", async () => {
    provider.mockResolvedValue({ text: "Нужны сливки 33 процента.", model: "test-model", usage: {} });
    expect(await answerFromRecipes("c", "Какие сливки?", "ru", "l")).toEqual({ text: "Нужны сливки 33 процента." });
    const [keys, , build, deadline] = provider.mock.calls[0];
    expect(keys).toEqual(["test-key"]);
    expect(deadline).toBe(25_000);
    const body = JSON.parse(build("test-model"));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(body.system_instruction.parts[0].text).not.toContain("Какие сливки?");
    expect(JSON.parse(body.contents[0].parts[0].text).studentQuestion).toBe("Какие сливки?");
    expect(logCall).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "course-assistant", model: "test-model", ok: true }));
  });
  it("an uncertainty marker abstains instead of fabricating a technical answer", async () => {
    provider.mockResolvedValue({ text: "НЕ_ЗНАЮ", model: "test-model", usage: {} });
    expect(await answerFromRecipes("c", "Можно другой продукт?", "ru")).toEqual({ text: null, reason: "no_material" });
  });
});
