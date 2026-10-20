import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
}));

import { getSetting, setSetting } from "../../src/db.js";
import {
  SETTING_KEYS,
  SECRET_MASK,
  isSettingKey,
  isSecretKey,
  readSettingsMasked,
  writeSettings,
  writeSetting,
} from "../../src/services/settingsService.js";

describe("settingsService", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset().mockResolvedValue(null);
    vi.mocked(setSetting).mockReset().mockResolvedValue(undefined);
  });

  it("isSettingKey: только ключи из списка", () => {
    expect(isSettingKey("aiModel")).toBe(true);
    expect(isSettingKey("aiModle")).toBe(false);
    expect(isSettingKey("__proto__")).toBe(false);
  });

  it("секреты отдаются маской, а не значением; пустой секрет — как есть (null)", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "igToken") return "real-token";
      if (key === "aiModel") return "gemini-3.7-flash";
      return null;
    });

    const out = await readSettingsMasked();

    expect(out.igToken).toBe(SECRET_MASK);
    expect(out.aiModel).toBe("gemini-3.7-flash");
    expect(out.geminiKey).toBeNull();
    expect(Object.keys(out)).toHaveLength(SETTING_KEYS.length);
    expect(JSON.stringify(out)).not.toContain("real-token");
  });

  it("writeSettings: неизвестные ключи и маска секрета пропускаются", async () => {
    const written = await writeSettings({
      aiModel: "gemini-3.7-flash",
      igToken: SECRET_MASK, // панель вернула маску — не затирать токен
      geminiKey: "new-key", // настоящий новый секрет — записать
      unknownKey: "x",
    });

    expect(written).toBe(2);
    expect(setSetting).toHaveBeenCalledWith("aiModel", "gemini-3.7-flash");
    expect(setSetting).toHaveBeenCalledWith("geminiKey", "new-key");
    expect(setSetting).not.toHaveBeenCalledWith("igToken", expect.anything());
    expect(setSetting).not.toHaveBeenCalledWith("unknownKey", expect.anything());
  });

  it("writeSetting обрезает пробелы и перенос строки (маркер Meta из формы)", async () => {
    await writeSetting("igToken", "  token\n");
    expect(setSetting).toHaveBeenCalledWith("igToken", "token");
    expect(isSecretKey("igToken")).toBe(true);
    expect(isSecretKey("aiModel")).toBe(false);
  });
});
