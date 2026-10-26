import { describe, it, expect, vi, beforeEach } from "vitest";

// Setting в памяти: модуль работает только через getSetting/setSetting и
// prisma.setting.updateMany/deleteMany.
const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  prisma: {
    setting: {
      updateMany: vi.fn(async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
        if (store.get(where.key) !== where.value) return { count: 0 };
        store.set(where.key, data.value);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => {
        for (const k of where.key.in) store.delete(k);
        return { count: 0 };
      }),
    },
  },
}));

const igGet = vi.fn();
vi.mock("../../src/ai/igGet.js", () => ({ igGet: (...a: unknown[]) => igGet(...a) }));

const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { checkIgToken, fingerprint, isTokenDead, shouldRefresh } from "../../src/igTokenWatch.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 26, 12);

function seed(token: string, extra: Record<string, number> = {}) {
  store.set("igToken", token);
  store.set("telegramBotToken", "tg");
  store.set("igTokenFingerprint", fingerprint(token));
  for (const [k, v] of Object.entries(extra)) store.set(k, String(v));
}

beforeEach(() => {
  store.clear();
  igGet.mockReset();
  sendTelegramMessage.mockClear();
});

describe("shouldRefresh", () => {
  it("не трогает маркер моложе суток — Meta такой не продлевает", () => {
    expect(shouldRefresh({ obtainedAt: T0, refreshedAt: null, expiresAt: null }, T0 + DAY - 1)).toBe(false);
    expect(shouldRefresh({ obtainedAt: T0, refreshedAt: null, expiresAt: null }, T0 + DAY)).toBe(true);
  });
  it("после продления ждёт неделю", () => {
    const s = { obtainedAt: T0, refreshedAt: T0, expiresAt: T0 + 60 * DAY };
    expect(shouldRefresh(s, T0 + 6 * DAY)).toBe(false);
    expect(shouldRefresh(s, T0 + 7 * DAY)).toBe(true);
  });
});

describe("isTokenDead", () => {
  it("узнаёт истёкший маркер по ответу Meta", () => {
    expect(isTokenDead('Instagram API 400: {"error":{"message":"Session has expired","type":"OAuthException","code":190}}')).toBe(true);
    expect(isTokenDead("fetch failed <- Connect Timeout Error")).toBe(false);
  });
});

describe("checkIgToken", () => {
  it("новый маркер: запоминает момент вставки и не продлевает сразу", async () => {
    store.set("igToken", "manual");
    await checkIgToken(T0);
    expect(igGet).not.toHaveBeenCalled();
    expect(store.get("igTokenFingerprint")).toBe(fingerprint("manual"));
    expect(store.get("igTokenObtainedAt")).toBe(String(T0));
  });

  it("через сутки продлевает и сохраняет новый маркер со сроком", async () => {
    seed("old", { igTokenObtainedAt: T0 });
    igGet.mockResolvedValue({ access_token: "new", token_type: "bearer", expires_in: 60 * 86_400 });
    await checkIgToken(T0 + DAY);
    expect(igGet).toHaveBeenCalledWith("/refresh_access_token", { grant_type: "ig_refresh_token" }, "old");
    expect(store.get("igToken")).toBe("new");
    expect(store.get("igTokenFingerprint")).toBe(fingerprint("new"));
    expect(store.get("igTokenExpiresAt")).toBe(String(T0 + DAY + 60 * DAY));
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("не затирает маркер, который владелец вставил во время запроса", async () => {
    seed("old", { igTokenObtainedAt: T0 });
    igGet.mockImplementation(async () => {
      store.set("igToken", "pasted-by-owner");
      return { access_token: "new", expires_in: 60 * 86_400 };
    });
    await checkIgToken(T0 + DAY);
    expect(store.get("igToken")).toBe("pasted-by-owner");
  });

  it("мёртвый маркер — сразу понятная тревога, и не чаще раза в 12 часов", async () => {
    seed("dead", { igTokenObtainedAt: T0 - 70 * DAY });
    igGet.mockRejectedValue(new Error('Instagram API 400: {"error":{"type":"OAuthException","code":190}}'));
    await checkIgToken(T0);
    await checkIgToken(T0 + 6 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Маркер доступа Instagram недействителен");
    await checkIgToken(T0 + 12 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("сетевой сбой далеко от истечения — молчит; за неделю до конца — предупреждает", async () => {
    seed("live", { igTokenObtainedAt: T0, igTokenRefreshedAt: T0, igTokenExpiresAt: T0 + 60 * DAY });
    igGet.mockRejectedValue(new Error("fetch failed <- Connect Timeout Error"));
    await checkIgToken(T0 + 7 * DAY);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    await checkIgToken(T0 + 54 * DAY);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("истекает");
  });
});
