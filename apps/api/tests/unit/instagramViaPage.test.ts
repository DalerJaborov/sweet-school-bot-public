import { beforeEach, describe, expect, it, vi } from "vitest";

// Instagram через Страницу Facebook (igSendVia=page) и мгновенная тревога, когда
// Meta отвергла ключ. Повод — CRM Royal Home 12.11.2026: сменили пароль, личный
// ключ Instagram умер, бот сутки молчал, а узнали только когда спросили.

const store = new Map<string, string>();
vi.mock("../../src/db.js", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  prisma: {},
}));
vi.mock("../../src/messaging/automation.js", () => ({ assertMessagingAllowed: vi.fn(async () => undefined) }));
const sendKind = vi.fn(async () => undefined);
vi.mock("../../src/notify.js", () => ({ sendKind: (...a: unknown[]) => sendKind(...a) }));

import { reactToInstagramMessage } from "../../src/instagram.js";

const fetchMock = vi.fn();

beforeEach(() => {
  store.clear();
  store.set("igToken", "IGAA-personal");
  store.set("fbPageToken", "EAA-system-page");
  fetchMock.mockReset();
  sendKind.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

const ok = () => new Response(JSON.stringify({ recipient_id: "1" }), { status: 200 });
const dead = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "The session has been invalidated because the user changed their password",
        type: "OAuthException",
        code: 190,
      },
    }),
    { status: 401 },
  );

describe("маршрут Instagram", () => {
  it("по умолчанию — Instagram Login, ключ Instagram", async () => {
    fetchMock.mockResolvedValue(ok());
    await reactToInstagramMessage("igsid-1", "mid-1", "❤️");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.instagram\.com\/v23\.0\/me\/messages/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer IGAA-personal");
  });

  it("igSendVia=page — graph.facebook.com и ключ Страницы, ключ Instagram не нужен вовсе", async () => {
    store.set("igSendVia", "page");
    store.delete("igToken");
    fetchMock.mockResolvedValue(ok());
    await reactToInstagramMessage("igsid-1", "mid-1", "❤️");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v23\.0\/me\/messages\?access_token=EAA-system-page$/);
  });
});

describe("Meta отвергла ключ при отправке — тревога сразу", () => {
  it("401/190 по ключу Instagram — владелец узнаёт в тот же момент, повтор в пределах 3 часов молчит", async () => {
    fetchMock.mockImplementation(async () => dead());
    await expect(reactToInstagramMessage("igsid-1", "mid-1", "❤️")).rejects.toMatchObject({ kind: "TOKEN" });
    await vi.waitFor(() => expect(sendKind).toHaveBeenCalledTimes(1));
    expect(sendKind.mock.calls[0][0]).toBe("failure");
    expect(String(sendKind.mock.calls[0][1])).toContain("Ключ Instagram");
    await expect(reactToInstagramMessage("igsid-1", "mid-2", "❤️")).rejects.toMatchObject({ kind: "TOKEN" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendKind).toHaveBeenCalledTimes(1);
  });

  it("через Страницу — тревога называет ключ Страницы", async () => {
    store.set("igSendVia", "page");
    fetchMock.mockImplementation(async () => dead());
    await expect(reactToInstagramMessage("igsid-1", "mid-1", "❤️")).rejects.toMatchObject({ kind: "TOKEN" });
    await vi.waitFor(() => expect(sendKind).toHaveBeenCalledTimes(1));
    expect(String(sendKind.mock.calls[0][1])).toContain("Ключ Страницы Facebook");
  });

  it("обычная ошибка (не ключ) — владельца не будим", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 100, message: "bad param" } }), { status: 400 }),
    );
    await expect(reactToInstagramMessage("igsid-1", "mid-1", "❤️")).rejects.toMatchObject({ kind: "PERMANENT" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendKind).not.toHaveBeenCalled();
  });
});
