import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  prisma: {},
}));

import { getSetting } from "../../src/db.js";

describe("libraryKind — только то, что принимает WhatsApp-мост", () => {
  it("принимает фото, mp4, голос, PDF и отвергает остальное", async () => {
    const { libraryKind } = await import("../../src/mediaLibrary.js");
    expect(libraryKind("image/jpeg")).toBe("image");
    expect(libraryKind("image/webp")).toBe("image");
    expect(libraryKind("video/mp4")).toBe("video");
    expect(libraryKind("audio/ogg")).toBe("audio");
    expect(libraryKind("audio/mpeg")).toBe("audio");
    expect(libraryKind("application/pdf")).toBe("file");
    expect(libraryKind("image/gif")).toBeNull();
    expect(libraryKind("video/quicktime")).toBeNull();
    expect(libraryKind("text/html")).toBeNull();
  });
});

describe("synthesizeSpeech — озвучка голосом Ширин", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    process.env.ELEVENLABS_API_KEY = "test-key-not-real";
    process.env.ELEVENLABS_VOICE_ID = "voice-123";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    vi.unstubAllGlobals();
  });

  it("выключено по умолчанию: без настройки в ElevenLabs не ходит", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    const { synthesizeSpeech } = await import("../../src/ai/voiceClone.js");
    await expect(synthesizeSpeech("Здравствуйте!")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("без ключа функция не настроена", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    vi.mocked(getSetting).mockResolvedValue("true");
    const { synthesizeSpeech, voiceEnabled } = await import("../../src/ai/voiceClone.js");
    await expect(synthesizeSpeech("Здравствуйте!")).rejects.toMatchObject({ status: 503 });
    expect(await voiceEnabled()).toBe(false);
  });

  it("режет слишком длинный и пустой текст до обращения в сеть", async () => {
    vi.mocked(getSetting).mockResolvedValue("true");
    const { synthesizeSpeech, MAX_VOICE_TEXT } = await import("../../src/ai/voiceClone.js");
    await expect(synthesizeSpeech("   ")).rejects.toMatchObject({ status: 400 });
    await expect(synthesizeSpeech("а".repeat(MAX_VOICE_TEXT + 1))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("включено: шлёт текст и ключ в заголовке, возвращает mp3", async () => {
    vi.mocked(getSetting).mockResolvedValue("true");
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(4000).buffer });
    const { synthesizeSpeech } = await import("../../src/ai/voiceClone.js");
    const audio = await synthesizeSpeech("Здравствуйте, это Ширин!");
    expect(audio.length).toBe(4000);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/text-to-speech/voice-123");
    expect(init.headers["xi-api-key"]).toBe("test-key-not-real");
    expect(String(url)).not.toContain("test-key-not-real");
    expect(JSON.parse(init.body).text).toBe("Здравствуйте, это Ширин!");
  });

  it("ошибка ElevenLabs не тащит в сообщение тело ответа", async () => {
    vi.mocked(getSetting).mockResolvedValue("true");
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "secret echo" });
    const { synthesizeSpeech } = await import("../../src/ai/voiceClone.js");
    await expect(synthesizeSpeech("Привет")).rejects.toMatchObject({ status: 502, message: "ElevenLabs ответил 401" });
  });
});

describe("кеш и потолок трат озвучки", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    process.env.ELEVENLABS_API_KEY = "test-key-not-real";
    process.env.ELEVENLABS_VOICE_ID = "voice-123";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    vi.unstubAllGlobals();
  });

  it("ключ кеша одинаков для того же текста независимо от пробелов и регистра", async () => {
    const { voiceCacheKey } = await import("../../src/ai/voiceClone.js");
    expect(voiceCacheKey("Здравствуйте,  это Ширин!")).toBe(voiceCacheKey(" здравствуйте, это ширин! "));
    expect(voiceCacheKey("Привет")).not.toBe(voiceCacheKey("Пока"));
  });

  it("потолок: при превышении отказ 429 и в ElevenLabs не ходим", async () => {
    const month = new Date().toISOString().slice(0, 7);
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "voiceCloneEnabled" ? "true" : key === "voiceSpend" ? `${month}|249990` : key === "voiceMonthlyCapUsd" ? "20" : null
    );
    vi.doMock("../../src/systemAlerts.js", () => ({ notifyOwnerDirect: vi.fn(async () => {}) }));
    const { synthesizeToFile } = await import("../../src/ai/voiceClone.js");
    await expect(synthesizeToFile("Короткая тёплая реплика для проверки потолка")).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decorateForV3 — одна метка в начале; v3 своя, v4 только из ELEVENLABS_TAG", () => {
  it("первый кусок получает ровно одну весёлую метку, остальные и не-v3 без меток", async () => {
    const { decorateForV3 } = await import("../../src/ai/voiceClone.js");
    const out = decorateForV3("Салом!", 0, 3, "eleven_v3");
    expect(out).toMatch(/^\[(happy|curious)\] Салом!$/);
    expect(decorateForV3("Салом!", 0, 3, "eleven_v3")).toBe(out);
    expect(decorateForV3("Середина.", 1, 3, "eleven_v3")).toBe("Середина.");
    expect(decorateForV3("Пишите.", 2, 3, "eleven_v3")).toBe("Пишите.");
    expect(decorateForV3("Салом!", 0, 1, "eleven_v4_turbo", "")).toBe("Салом!");
    expect(decorateForV3("Салом!", 0, 1, "eleven_v4_turbo", "[warm]")).toBe("[warm] Салом!");
    expect(decorateForV3("Дуюм.", 1, 2, "eleven_v4", "[warm]")).toBe("Дуюм.");
    expect((out.match(/\[/g) ?? []).length).toBe(1);
  });
});

describe("voiceFilter — темп только для озвучки бота", () => {
  it("1.0 и мусор дают чистый фильтр, 1.07 добавляет atempo", async () => {
    const { voiceFilter, VOICE_FILTER } = await import("../../src/ai/audioConvert.js");
    expect(voiceFilter()).toBe(VOICE_FILTER);
    expect(voiceFilter(1)).toBe(VOICE_FILTER);
    expect(voiceFilter(Number.NaN)).toBe(VOICE_FILTER);
    expect(voiceFilter(1.07)).toBe(`atempo=1.070,${VOICE_FILTER}`);
  });
});
