import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * Найдено 06.09.2026: расшифровка урока стоила денег (сильная модель
 * gemini-3.1-pro-preview на аудио), но нигде не записывалась в AiLog — на
 * вопрос владельца «сколько это стоило» отвечать было не по чему. Теперь тот
 * же путь, что у остального Gemini.
 */
const generateWithFallback = vi.fn();
vi.mock("../../src/gemini.js", () => ({
  generateWithFallback: (...a: unknown[]) => generateWithFallback(...a),
  thinkingConfigFor: () => undefined,
}));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key-1"]) }));
vi.mock("../../src/ai/media.js", () => ({ buildMediaPart: vi.fn(async () => ({ inline_data: { mime_type: "audio/mpeg", data: "AA==" } })) }));
const logAiCall = vi.fn(async () => undefined);
vi.mock("../../src/ai/aiLog.js", () => ({ logAiCall: (...a: unknown[]) => logAiCall(...a) }));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcribeLesson } from "../../src/course/transcribe.js";

let db: PrismaMock;
let audioFile: string;
beforeEach(() => {
  audioFile = path.join(os.tmpdir(), `transcribe-test-${Date.now()}.mp3`);
  fs.writeFileSync(audioFile, "audio");
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key === "lessonTranscribeEnabled" ? null : null
  );
  db.model("lesson").findUnique.mockResolvedValue({ durationSec: 600 });
  db.model("lesson").update.mockResolvedValue({});
  logAiCall.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
  fs.rmSync(audioFile, { force: true });
});

describe("transcribeLesson — расход пишется в журнал", () => {
  it("успешная расшифровка — logAiCall с моделью и usage", async () => {
    generateWithFallback.mockResolvedValue({
      text: "Салом, имруз мо як тортро тайёр мекунем ва хеле хуб мешавад дар охир.",
      model: "gemini-3.1-pro-preview",
      usage: { inputTokens: 12000, outputTokens: 400, cacheReadTokens: 0 },
    });
    const ok = await transcribeLesson("lesson-1", audioFile);
    expect(ok).toBe(true);
    expect(logAiCall).toHaveBeenCalledTimes(1);
    expect(logAiCall).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "lesson-transcribe", model: "gemini-3.1-pro-preview", ok: true })
    );
  });

  it("сбой модели — тоже пишется в журнал, но ok: false", async () => {
    generateWithFallback.mockResolvedValue({ error: "все ключи отказали" });
    const ok = await transcribeLesson("lesson-1", audioFile);
    expect(ok).toBe(false);
    expect(logAiCall).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "lesson-transcribe", ok: false }));
  });
});
