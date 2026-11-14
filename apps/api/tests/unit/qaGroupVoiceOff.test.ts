import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Автоответ учебной Telegram-группы шлёт живое голосовое Ширин из архива.
 * Выключенный голос (voiceReplyEnabled) должен глушить и его — иначе
 * панель обещает «голоса нет», а ученица его получает (ревью 12.11.2026).
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  match: null as null | { ownerText: string; mediaType: string | null; mediaUrl: string | null },
  texts: [] as string[],
  voices: [] as string[],
}));

vi.mock("../../src/db.js", () => ({
  prisma: { qaMessage: { create: vi.fn(async () => ({})) } },
  getSetting: vi.fn(async (key: string) => state.settings[key] ?? null),
  logError: vi.fn(),
}));
vi.mock("../../src/telegram.js", () => ({
  downloadTelegramFile: vi.fn(async () => null),
  sendTelegramMessage: vi.fn(async (_t: string, _c: string, text: string) => {
    state.texts.push(text);
  }),
  sendTelegramVoice: vi.fn(async (_t: string, _c: string, url: string) => {
    state.voices.push(url);
  }),
}));
vi.mock("../../src/upload.js", () => ({ saveOwnerMedia: vi.fn(() => null) }));
vi.mock("../../src/ai/qaGroupReply.js", () => ({ findQaAnswer: vi.fn(async () => state.match) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: vi.fn(async () => null) }));

import { handleQaGroupMessage } from "../../src/qaGroup.js";

const studentMsg = { message_id: 7, chat: { id: -100 }, from: { id: 555 }, text: "как сделать крем" } as never;

describe("Автоответ в учебной группе при выключенном голосе", () => {
  beforeEach(() => {
    state.settings = {
      telegramBotToken: "t",
      telegramQaGroupId: "-100",
      telegramQaOwnerId: "1",
      qaAutoReplyEnabled: "true",
    };
    state.texts = [];
    state.voices = [];
  });

  it("голос выключен, у ответа есть текст и голос: уходит только текст", async () => {
    state.settings.voiceReplyEnabled = "false";
    state.match = { ownerText: "Взбейте сливки", mediaType: "audio", mediaUrl: "https://x/v.ogg" };

    await handleQaGroupMessage(studentMsg);

    expect(state.texts.length).toBe(1);
    expect(state.voices).toEqual([]);
  });

  it("голос выключен, ответ — только голос: в группу ничего не уходит (и без метки «голосовой ответ»)", async () => {
    state.match = { ownerText: "", mediaType: "audio", mediaUrl: "https://x/v.ogg" };

    await handleQaGroupMessage(studentMsg);

    expect(state.texts).toEqual([]);
    expect(state.voices).toEqual([]);
  });

  it("голос включён: голосовое Ширин уходит как раньше", async () => {
    state.settings.voiceReplyEnabled = "true";
    state.match = { ownerText: "", mediaType: "audio", mediaUrl: "https://x/v.ogg" };

    await handleQaGroupMessage(studentMsg);

    expect(state.voices).toEqual(["https://x/v.ogg"]);
  });
});
