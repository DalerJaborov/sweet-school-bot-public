import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
vi.mock("../../src/db.js", () => ({ getSetting: vi.fn(async (k: string) => settings.get(k) ?? null) }));
vi.mock("../../src/course/delivery.js", () => ({ deliveryModeFor: vi.fn(async () => "telegram") }));

const { videoHelpPrompt, DEFAULT_VIDEO_HELP_URL, VIDEO_HELP_SETTING } = await import("../../src/ai/deliveryContext.js");

// Владелец 12.11.2026: вместо длинной инструкции про кэш — короткая фраза и видео.
describe("видео «не открывается видео»", () => {
  beforeEach(() => settings.clear());

  it("по умолчанию даёт модели видео владельца и запрещает инструкцию про кэш", async () => {
    const p = await videoHelpPrompt();
    expect(DEFAULT_VIDEO_HELP_URL).toBe("https://youtube.com/shorts/9aTIJj4tMd8");
    expect(p).toContain(DEFAULT_VIDEO_HELP_URL);
    expect(p).toMatch(/не пиши инструкцию про кэш/u);
    expect(p).not.toContain("?si=");
  });

  it("своя ссылка из настройки", async () => {
    settings.set(VIDEO_HELP_SETTING, "https://youtu.be/abc");
    expect(await videoHelpPrompt()).toContain("https://youtu.be/abc");
  });

  it("пусто или false — выключено", async () => {
    settings.set(VIDEO_HELP_SETTING, "");
    expect(await videoHelpPrompt()).toBe("");
    settings.set(VIDEO_HELP_SETTING, "false");
    expect(await videoHelpPrompt()).toBe("");
  });
});
