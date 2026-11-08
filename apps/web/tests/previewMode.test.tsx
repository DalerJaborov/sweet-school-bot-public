import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup, act, render, screen } from "@testing-library/react";

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
  enqueueProgress: vi.fn(async () => undefined),
  markCompleted: vi.fn(async () => undefined),
  markUsed: vi.fn(async () => undefined),
  markLessonOpened: vi.fn(async () => undefined),
  downloadLesson: vi.fn(async () => true),
}));
vi.mock("../src/course/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/course/offline")>();
  return { ...actual, ...offline };
});

import { useCourse } from "../src/course/hooks/useCourse";
import { saveProgress, saveProgressBeacon, sendChat, saveProfile, manifestUrl, startPreview } from "../src/course/api";
import { ChatThread } from "../src/course/chat/ChatThread";
import { dict } from "../src/course/i18n";

/**
 * «Посмотреть как ученица» в приложении ученицы: билет из адреса → кука,
 * дальше только чтение. Ничего не пишется ни на сервер, ни в телефон.
 */

const LESSON = {
  id: "l1",
  title: "Урок 1",
  durationSec: 600,
  ready: true,
  recipeText: null,
  recipePhotos: [],
  posterUrl: null,
  positionSec: 0,
  percent: 0,
  completed: false,
};
const VIEW = {
  ready: true,
  preview: true,
  watermark: "Предпросмотр",
  profile: { firstName: null, lastName: null, language: "tg" },
  school: null,
  offlineUntil: null,
  courses: [
    {
      id: "c1",
      code: "C",
      title: "Курс",
      description: null,
      purchaseId: null,
      modules: [{ id: "m1", title: "Р", lessons: [LESSON] }],
    },
  ],
};

let calls: { url: string; method: string }[];

beforeEach(() => {
  calls = [];
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      const body = String(url).includes("/preview/me") ? VIEW : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  for (const fn of Object.values(offline)) fn.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/course");
});

describe("предпросмотр владельца", () => {
  it("билет меняется на куку один раз, адрес чистится, дальше — только /preview/me", async () => {
    window.history.replaceState(null, "", "/course?preview=TICKET");
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.view).not.toBeNull());

    expect(calls[0]).toEqual({ url: "/api/course/preview/start", method: "POST" });
    expect(calls[1].url).toBe("/api/course/preview/me?lang=tg");
    expect(window.location.search).toBe("?mode=preview");
    // Ни входа ученицы, ни её /me.
    expect(calls.some((c) => c.url === "/api/course/open" || c.url === "/api/course/me")).toBe(false);
    // Телефон не трогаем: ни копии /me, ни сервис-воркера, ни уборки.
    expect(offline.saveMe).not.toHaveBeenCalled();
    expect(offline.registerServiceWorker).not.toHaveBeenCalled();
    expect(offline.sweepPartials).not.toHaveBeenCalled();
  });

  it("просмотр урока не пишет прогресс и не сохраняет урок в телефон", async () => {
    window.history.replaceState(null, "", "/course?mode=preview");
    const { result } = renderHook(() => useCourse());
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const before = calls.length;

    act(() => {
      result.current.noteOpened("l1");
      result.current.reportProgress(LESSON, 120, 99);
      result.current.reportProgress(LESSON, 130, 99, "beacon");
    });
    // В этой вкладке видно, где остановилась…
    expect(result.current.lessons[0].positionSec).toBe(130);
    // …но на сервер и в телефон не ушло ничего.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
    expect(offline.enqueueProgress).not.toHaveBeenCalled();
    expect(offline.markCompleted).not.toHaveBeenCalled();
    expect(offline.markUsed).not.toHaveBeenCalled();
    expect(offline.downloadLesson).not.toHaveBeenCalled();
  });

  it("запись на сервер в предпросмотре закрыта на уровне клиента API", async () => {
    window.history.replaceState(null, "", "/course?mode=preview");
    await expect(saveProgress("l1", 10, 50)).resolves.toEqual({ completed: false });
    expect(saveProgressBeacon("l1", 10, 50)).toBe(true);
    await expect(sendChat("вопрос", "l1")).rejects.toMatchObject({ reason: "preview" });
    await expect(saveProfile({ firstName: "А", lastName: "", language: "ru" })).rejects.toMatchObject({
      reason: "preview",
    });
    expect(calls).toHaveLength(0);
    expect(manifestUrl("l1")).toBe("/api/course/preview/lessons/l1/manifest");
  });

  it("чат в предпросмотре — подсказка вместо поля, вопрос в очередь телефона не попадает", () => {
    window.history.replaceState(null, "", "/course?mode=preview");
    const t = dict("ru");
    render(<ChatThread t={t} lessonId="l1" online />);
    expect(screen.getByText(t.previewChatOff)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("один билет — один обмен, даже если старт позвали дважды (двойной эффект React)", async () => {
    await Promise.all([startPreview("T2"), startPreview("T2")]);
    expect(calls.filter((c) => c.url === "/api/course/preview/start")).toHaveLength(1);
  });

  it("обычный режим ученицы не изменился: адрес урока прежний", () => {
    window.history.replaceState(null, "", "/course");
    expect(manifestUrl("l1")).toBe("/api/course/lessons/l1/manifest");
  });
});
