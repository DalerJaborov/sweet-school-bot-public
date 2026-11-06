import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void store.set(k, v)),
}));
const owners = vi.fn(async () => ["owner-1"]);
const send = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  ownerAlertChatIds: () => owners(),
  sendTelegramMessage: (...a: unknown[]) => send(...a),
}));

import { checkAppSecret } from "../../src/appSecretWatch.js";

const T0 = Date.UTC(2026, 10, 7, 12);
beforeEach(() => {
  store.clear();
  send.mockClear();
  owners.mockResolvedValue(["owner-1"]);
  store.set("telegramBotToken", "tok");
});

describe("checkAppSecret", () => {
  it("секрет задан — молчит", async () => {
    store.set("appSecret", "abc");
    expect(await checkAppSecret(T0)).toBe("ok");
    expect(send).not.toHaveBeenCalled();
  });
  it("секрет пуст — тревога владельцу", async () => {
    store.set("appSecret", "  ");
    expect(await checkAppSecret(T0)).toBe("alerted");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("повторно в пределах 12 часов не шлёт, после — шлёт", async () => {
    await checkAppSecret(T0);
    expect(await checkAppSecret(T0 + 3_600_000)).toBe("cooldown");
    expect(await checkAppSecret(T0 + 13 * 3_600_000)).toBe("alerted");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("нет чата владельца — не падает и сообщает об этом", async () => {
    owners.mockResolvedValue([]);
    expect(await checkAppSecret(T0)).toBe("no-recipient");
    expect(send).not.toHaveBeenCalled();
  });
});
