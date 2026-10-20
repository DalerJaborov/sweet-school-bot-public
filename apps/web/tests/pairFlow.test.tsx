import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  loadPair: vi.fn<() => Promise<string | undefined>>(),
  clearPair: vi.fn(async () => undefined),
  savePair: vi.fn(async () => undefined),
}));
vi.mock("../src/course/offline", () => store);

import { CourseError, loadCourse, openWithToken } from "../src/course/api";

type Call = { url: string; body: unknown };

/** Сценарий ответов по порядку; каждый вызов fetch записывается в calls. */
function mockFetch(responses: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  store.loadPair.mockReset();
  store.clearPair.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Восстановление сессии токеном спаривания (дизайн доступа 03.09.2026):
 * iOS у установленного приложения свои куки, и они пропадают. Если в телефоне
 * есть pair-токен, при 401 «нет сессии» — один /pair и один повтор. Один, а
 * не «пока не получится»: иначе отозванный доступ крутил бы петлю запросов.
 */
describe("request(): 401 no_session → /pair → повтор", () => {
  it("ГЛАВНОЕ: куки пропали, токен есть — чиним и повторяем /me один раз", async () => {
    store.loadPair.mockResolvedValue("PAIR1");
    const calls = mockFetch([
      { status: 401, body: { error: "нет сессии", reason: "no_session" } },
      { status: 200, body: { ok: true, contactId: "c1" } },
      { status: 200, body: { ready: true, courses: [] } },
    ]);
    const view = await loadCourse();
    expect(view.ready).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["/api/course/me", "/api/course/pair", "/api/course/me"]);
    expect(calls[1].body).toEqual({ pair: "PAIR1" });
  });

  it("после /pair снова 401 — отдаём ошибку, второго круга нет", async () => {
    store.loadPair.mockResolvedValue("PAIR1");
    const calls = mockFetch([
      { status: 401, body: { error: "нет сессии", reason: "no_session" } },
      { status: 200, body: { ok: true, contactId: "c1" } },
      { status: 401, body: { error: "нет сессии", reason: "no_session" } },
    ]);
    await expect(loadCourse()).rejects.toMatchObject({ reason: "no_session", status: 401 });
    expect(calls.length).toBe(3);
  });

  it("токена в телефоне нет — сразу 401 без /pair", async () => {
    store.loadPair.mockResolvedValue(undefined);
    const calls = mockFetch([{ status: 401, body: { error: "нет сессии", reason: "no_session" } }]);
    await expect(loadCourse()).rejects.toBeInstanceOf(CourseError);
    expect(calls.map((c) => c.url)).toEqual(["/api/course/me"]);
  });

  it("доступ отозван — токен спаривания стираем, повтора нет", async () => {
    store.loadPair.mockResolvedValue("PAIR1");
    const calls = mockFetch([
      { status: 401, body: { error: "нет сессии", reason: "no_session" } },
      { status: 403, body: { error: "доступ закрыт", reason: "revoked" } },
    ]);
    await expect(loadCourse()).rejects.toMatchObject({ reason: "no_session" });
    expect(calls.length).toBe(2);
    expect(store.clearPair).toHaveBeenCalled();
  });
});

describe("openWithToken(): лимит устройств", () => {
  it("429 device_limit несёт список устройств и число замен", async () => {
    store.loadPair.mockResolvedValue(undefined);
    mockFetch([
      {
        status: 429,
        body: {
          error: "лимит",
          reason: "device_limit",
          devices: [{ id: "d1", label: "iPhone", city: null, lastSeenAt: null, blocked: false }],
          swapsLeft: 2,
        },
      },
    ]);
    let caught: unknown;
    try {
      await openWithToken("T");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CourseError);
    const limit = (caught as CourseError).deviceLimit();
    expect(limit?.swapsLeft).toBe(2);
    expect(limit?.devices[0].label).toBe("iPhone");
  });

  it("replaceOldest уходит в тело запроса только когда ученица подтвердила", async () => {
    store.loadPair.mockResolvedValue(undefined);
    const calls = mockFetch([{ status: 200, body: { ok: true, contactId: "c1" } }]);
    await openWithToken("T");
    await openWithToken("T", true);
    expect((calls[0].body as Record<string, unknown>).replaceOldest).toBeUndefined();
    expect((calls[1].body as Record<string, unknown>).replaceOldest).toBe(true);
  });
});
