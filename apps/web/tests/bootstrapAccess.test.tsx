import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { CourseError } from "../src/course/api";

const api = vi.hoisted(() => ({
  loadCourse: vi.fn(),
  openWithToken: vi.fn(),
  pairDevice: vi.fn(),
  saveProgress: vi.fn(async () => ({ completed: false })),
  saveProgressBeacon: vi.fn(() => true),
  saveLanguage: vi.fn(async () => ({ ok: true })),
  offlinePayload: vi.fn(),
}));
vi.mock("../src/course/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/course/api")>();
  return { ...actual, ...api };
});

const offline = vi.hoisted(() => ({
  loadMe: vi.fn(async () => undefined),
  saveMe: vi.fn(async () => undefined),
  clearMe: vi.fn(async () => undefined),
  savePair: vi.fn(async () => undefined),
  listLessons: vi.fn(async () => []),
  sweepPartials: vi.fn(async () => 0),
  registerServiceWorker: vi.fn(async () => true),
  requestPersistentStorage: vi.fn(async () => true),
  flushProgressQueue: vi.fn(async () => 0),
  markLessonOpened: vi.fn(async () => undefined),
}));
vi.mock("../src/course/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/course/offline")>();
  return { ...actual, ...offline };
});

const detect = vi.hoisted(() => ({ inApp: false }));
vi.mock("../src/course/install/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/course/install/detect")>();
  return {
    ...actual,
    environment: () => ({ platform: "ios", standalone: false, inApp: detect.inApp, browser: "safari" }),
  };
});

const reload = vi.hoisted(() => ({ reloadWithoutToken: vi.fn() }));
vi.mock("../src/course/install/reload", () => reload);

import { useCourse } from "../src/course/hooks/useCourse";

const VIEW = { ready: true, courses: [], profile: { firstName: "М", lastName: null, language: "ru" } };

beforeEach(() => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  api.loadCourse.mockReset().mockResolvedValue(VIEW);
  api.openWithToken.mockReset().mockResolvedValue({ ok: true, contactId: "c1" });
  api.pairDevice.mockReset().mockResolvedValue({ ok: true, contactId: "c1" });
  offline.savePair.mockClear();
  reload.reloadWithoutToken.mockClear();
  detect.inApp = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/course");
});

/**
 * Старт с токеном (дизайн доступа 03.09.2026): встроенный браузер → экран
 * выхода без входа; лимит устройств → экран замены; успех → адрес без токена.
 */
describe("useCourse: вход по ссылке", () => {
  it("ГЛАВНОЕ: встроенный браузер — /open не зовём, токен в адресе оставляем", async () => {
    detect.inApp = true;
    window.history.replaceState(null, "", "/course?token=abc");
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.inAppTrap).toBe(true));
    expect(api.openWithToken).not.toHaveBeenCalled();
    expect(api.loadCourse).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?token=abc");
  });

  it("лимит устройств: экран с устройствами, «заменить» повторяет /open с replaceOldest", async () => {
    window.history.replaceState(null, "", "/course?token=abc");
    api.openWithToken.mockRejectedValueOnce(
      new CourseError(429, "лимит", "device_limit", {
        devices: [{ id: "d1", label: "iPhone", city: null, lastSeenAt: null, blocked: false }],
        swapsLeft: 1,
      }),
    );
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.deviceLimit).not.toBeNull());
    expect(result.current.deviceLimit?.swapsLeft).toBe(1);
    expect(result.current.error).toBeNull();
    // Токен всё ещё в адресе — иначе повторить вход было бы нечем.
    expect(window.location.search).toBe("?token=abc");

    await act(async () => {
      await result.current.replaceOldestDevice();
    });
    expect(api.openWithToken).toHaveBeenLastCalledWith("abc", true);
    await waitFor(() => expect(result.current.deviceLimit).toBeNull());
    expect(reload.reloadWithoutToken).toHaveBeenCalledTimes(1);
  });

  it("?pair= — обмен на куки того же устройства, токен сохранён, адрес чист", async () => {
    window.history.replaceState(null, "", "/course?pair=P1");
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(api.pairDevice).toHaveBeenCalledWith("P1");
    expect(offline.savePair).toHaveBeenCalledWith("P1");
    expect(api.openWithToken).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("успешный вход по токену — адрес без токена (перезагрузка ради личного манифеста)", async () => {
    window.history.replaceState(null, "", "/course?token=abc");
    renderHook(() => useCourse());
    await waitFor(() => expect(api.openWithToken).toHaveBeenCalledWith("abc", false));
    await waitFor(() => expect(reload.reloadWithoutToken).toHaveBeenCalledTimes(1));
    // Именно перезагрузка, а не /me на месте: манифест должен приехать с кукой.
    expect(api.loadCourse).not.toHaveBeenCalled();
  });
});
