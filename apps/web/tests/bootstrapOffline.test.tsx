import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import type { CourseView } from "../src/course/api";

const api = vi.hoisted(() => ({
  loadCourse: vi.fn(),
  openWithToken: vi.fn(),
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
  loadMe: vi.fn(),
  saveMe: vi.fn(async () => undefined),
  clearMe: vi.fn(async () => undefined),
  listLessons: vi.fn(async () => [{ lessonId: "l1", title: "Наполеон", segments: 3, bytes: 1, savedAt: 1, lastUsedAt: 1, completed: false }]),
  sweepPartials: vi.fn(async () => 0),
  registerServiceWorker: vi.fn(async () => true),
  requestPersistentStorage: vi.fn(async () => true),
  flushProgressQueue: vi.fn(async () => 0),
  enqueueProgress: vi.fn(async () => undefined),
  updateCachedProgress: vi.fn(async () => undefined),
  markUsed: vi.fn(async () => undefined),
  markCompleted: vi.fn(async () => undefined),
  evictIfNeeded: vi.fn(async () => undefined),
  downloadLesson: vi.fn(async () => true),
}));
vi.mock("../src/course/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/course/offline")>();
  return { ...actual, ...offline };
});

import { useCourse } from "../src/course/hooks/useCourse";

const view: CourseView = {
  ready: true,
  watermark: "Малика · 1234",
  profile: { firstName: "Малика", lastName: null, language: "ru" },
  school: { telegram: null, instagram: null, whatsapp: null },
  offlineUntil: null,
  courses: [
    {
      id: "c1",
      code: "COURSE50",
      title: "Арт-десерты",
      description: null,
      purchaseId: "p1",
      modules: [
        {
          id: "m1",
          title: "Уроки",
          lessons: [
            { id: "l1", title: "Наполеон", durationSec: 600, ready: true, recipeText: null, recipePhotos: [], posterUrl: null, positionSec: 0, percent: 0, completed: false },
            { id: "l2", title: "Медовик", durationSec: 600, ready: true, recipeText: null, recipePhotos: [], posterUrl: null, positionSec: 0, percent: 0, completed: false },
          ],
        },
      ],
    },
  ],
} as CourseView;

beforeEach(() => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  api.loadCourse.mockReset();
  offline.loadMe.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * ОФЛАЙН БОЛЬШЕ НЕ ТУПИК. Разбор UX 03.09.2026: без сети приложение показывало
 * ошибку с кнопкой «повторить», а рядом обещало «сохранённые уроки откроются
 * без интернета» — ровно тогда, когда они не открывались.
 */
describe("useCourse без сети", () => {
  it("ГЛАВНОЕ: сеть упала — экран строится из сохранённой копии /me", async () => {
    api.loadCourse.mockRejectedValue(new TypeError("Failed to fetch"));
    offline.loadMe.mockResolvedValue({ view, savedAt: Date.now() });

    const { result } = renderHook(() => useCourse());

    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(result.current.source).toBe("cache");
    expect(result.current.error).toBeNull();
    expect(result.current.courses.map((c) => c.title)).toEqual(["Арт-десерты"]);
    // Что лежит в телефоне — известно, строки без копии приложение отключит.
    await waitFor(() => expect(result.current.offline.l1).toBeTruthy());
    expect(result.current.offline.l2).toBeUndefined();
  });

  it("копии нет и сети нет — честная сетевая ошибка", async () => {
    api.loadCourse.mockRejectedValue(new TypeError("Failed to fetch"));
    offline.loadMe.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCourse());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.reason).toBe("network");
  });

  it("сеть есть — свежий /me сохраняется в копию на следующий раз", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    api.loadCourse.mockResolvedValue(view);

    const { result } = renderHook(() => useCourse());

    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(result.current.source).toBe("network");
    expect(offline.saveMe).toHaveBeenCalledWith(view);
  });

  it("отозванный доступ — копию стираем, ошибку показываем", async () => {
    const { CourseError } = await import("../src/course/api");
    api.loadCourse.mockRejectedValue(new CourseError(403, "Доступ закрыт", "revoked"));
    offline.loadMe.mockResolvedValue({ view, savedAt: Date.now() });

    const { result } = renderHook(() => useCourse());

    await waitFor(() => expect(result.current.error?.reason).toBe("revoked"));
    expect(offline.clearMe).toHaveBeenCalled();
    expect(result.current.view).toBeNull();
  });

  it("a background reconnect revocation closes an already open cached course", async () => {
    const { CourseError } = await import("../src/course/api");
    api.loadCourse.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    offline.loadMe.mockResolvedValue({ view, savedAt: Date.now() });
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.source).toBe("cache"));
    expect(result.current.view).not.toBeNull();

    api.loadCourse.mockRejectedValue(new CourseError(403, "Доступ закрыт", "revoked"));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.error?.reason).toBe("revoked"));
    expect(result.current.view).toBeNull();
    expect(result.current.offline).toEqual({});
  });
});
