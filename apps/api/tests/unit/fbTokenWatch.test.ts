import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
const sendTelegramMessage = vi.fn(async () => 1);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  chatsForKind: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { assessFbToken, checkFbToken, isPersonalPageToken } from "../../src/fbTokenWatch.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const sec = (ms: number) => Math.floor(ms / 1000);

function mockMeta(data: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status })));
}

beforeEach(() => {
  store.clear();
  sendTelegramMessage.mockClear();
  store.set("fbPageToken", "page-token");
  store.set("telegramBotToken", "tg");
});

describe("assessFbToken", () => {
  it("бессрочный маркер с далёким сроком доступа — всё хорошо", () => {
    expect(assessFbToken({ is_valid: true, expires_at: 0, data_access_expires_at: sec(NOW + 60 * DAY) }, NOW)).toBeNull();
  });
  it("доступ к данным кончается через 7 дней или раньше — предупреждение", () => {
    expect(assessFbToken({ is_valid: true, expires_at: 0, data_access_expires_at: sec(NOW + 6 * DAY) }, NOW)).toMatch(/^🟠/);
  });
  it("срок уже прошёл — красная тревога", () => {
    expect(assessFbToken({ is_valid: true, expires_at: 0, data_access_expires_at: sec(NOW - DAY) }, NOW)).toMatch(/^🔴/);
  });
  it("недействительный маркер — красная тревога", () => {
    expect(assessFbToken({ is_valid: false }, NOW)).toMatch(/^🔴/);
  });
  it("берёт ближайшую из двух дат", () => {
    expect(assessFbToken({ is_valid: true, expires_at: sec(NOW + 3 * DAY), data_access_expires_at: sec(NOW + 80 * DAY) }, NOW)).toMatch(/^🟠/);
  });
});

describe("ключ системного пользователя и Instagram через Страницу", () => {
  it("дата доступа к данным есть только у личного ключа", () => {
    expect(isPersonalPageToken({ is_valid: true, data_access_expires_at: sec(NOW + 7 * DAY) })).toBe(true);
    expect(isPersonalPageToken({ is_valid: true, expires_at: 0, data_access_expires_at: 0 })).toBe(false);
  });
  it("Instagram через Страницу, а права instagram_manage_messages у ключа нет — красная тревога", () => {
    const info = { is_valid: true, expires_at: 0, data_access_expires_at: 0, scopes: ["pages_messaging", "public_profile"] };
    expect(assessFbToken(info, NOW, { igViaPage: true })).toMatch(/^🔴.*instagram_manage_messages/);
    expect(assessFbToken(info, NOW)).toBeNull();
  });
  it("бессрочный ключ с нужными правами — тишина", () => {
    const info = { is_valid: true, expires_at: 0, data_access_expires_at: 0, scopes: ["pages_messaging", "instagram_manage_messages"] };
    expect(assessFbToken(info, NOW, { igViaPage: true })).toBeNull();
  });
  it("тревога ведёт к системному пользователю shirin-bot, а не к личному «Generate token»", () => {
    expect(assessFbToken({ is_valid: false }, NOW)).toContain("shirin-bot");
  });
});

describe("checkFbToken", () => {
  it("Instagram через Страницу без нужного права — тревога и в плановой проверке", async () => {
    store.set("igSendVia", "page");
    mockMeta({ data: { is_valid: true, expires_at: 0, data_access_expires_at: 0, scopes: ["pages_messaging"] } });
    await checkFbToken(NOW);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it("без маркера ничего не делает", async () => {
    store.delete("fbPageToken");
    mockMeta({});
    await checkFbToken(NOW);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
  it("здоровый маркер — тишина", async () => {
    mockMeta({ data: { is_valid: true, expires_at: 0, data_access_expires_at: sec(NOW + 40 * DAY) } });
    await checkFbToken(NOW);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
  it("скоро истекает доступ — одно сообщение, повтор в пределах 12 часов молчит", async () => {
    mockMeta({ data: { is_valid: true, expires_at: 0, data_access_expires_at: sec(NOW + 2 * DAY) } });
    await checkFbToken(NOW);
    await checkFbToken(NOW + 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    await checkFbToken(NOW + 13 * 3_600_000);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  });
  it("код 190 от Meta — маркер мёртв, тревога", async () => {
    mockMeta({ error: { code: 190, message: "expired" } }, 400);
    await checkFbToken(NOW);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it("сбой сети не будит владельца", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    await checkFbToken(NOW);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
