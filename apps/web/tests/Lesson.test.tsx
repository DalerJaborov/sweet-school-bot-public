import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Lesson } from "../src/course/screens/Lesson";
import { dict } from "../src/course/i18n";
import type { LessonView } from "../src/course/api";
import type { CourseState } from "../src/course/hooks/useCourse";

afterEach(cleanup);

const t = dict("ru");

// Player тянет hls.js и реальное видео — здесь важно только ЧТО показывает
// Lesson (геройский экран или плеер), а не как плеер работает изнутри
// (это уже проверяет Player.test.tsx).
vi.mock("../src/course/player/Player", () => ({
  Player: ({ title, src, onFatalError }: { title: string; src: string; onFatalError?: () => void }) => <div data-testid="player-stub" data-src={src}><button onClick={onFatalError}>fail</button>{title}</div>,
}));

function lesson(over: Partial<LessonView> = {}): LessonView {
  return {
    id: "l1",
    title: "Наполеон",
    durationSec: 1440,
    ready: true,
    recipeText: null,
    recipePhotos: [],
    posterUrl: null,
    positionSec: 0,
    percent: 0,
    completed: false,
    ...over,
  };
}

function fakeState(): CourseState {
  return {
    t,
    view: undefined,
    courses: [],
    offline: {},
    saving: {},
    online: true,
    reportProgress: vi.fn(),
  } as unknown as CourseState;
}

/**
 * ГЕРОЙСКИЙ ЭКРАН НА ЭКРАНЕ УРОКА (§4 визуальной системы 04.09.2026):
 * показывается для свежего открытия (startAt === 0) и уступает место плееру
 * по тапу; при «Продолжить с 12:30» (startAt > 0) экран пропускается — это
 * защищает принцип «один тап», которым уже живёт LessonCard.
 */
describe("Lesson — переключение геройского экрана и плеера", () => {
  it("свежее открытие (startAt=0) — сперва геройский экран, плеера ещё нет", () => {
    render(<Lesson state={fakeState()} lesson={lesson()} startAt={0} nonce={1} onBack={vi.fn()} />);
    expect(screen.queryByTestId("player-stub")).toBeNull();
    expect(screen.getByRole("button", { name: t.videoLabel("Наполеон") })).toBeTruthy();
  });

  it("тап по геройскому экрану переводит на плеер", () => {
    render(<Lesson state={fakeState()} lesson={lesson()} startAt={0} nonce={1} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t.videoLabel("Наполеон") }));
    expect(screen.getByTestId("player-stub")).toBeTruthy();
  });

  it("продолжение (startAt>0) — сразу плеер, геройский экран пропущен ради одного тапа", () => {
    render(<Lesson state={fakeState()} lesson={lesson({ positionSec: 750 })} startAt={750} nonce={1} onBack={vi.fn()} />);
    expect(screen.getByTestId("player-stub")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.videoLabel("Наполеон") })).toBeNull();
  });

  it("новое открытие того же урока с начала (новый nonce, startAt=0) — геройский экран возвращается", () => {
    const { rerender } = render(
      <Lesson state={fakeState()} lesson={lesson({ positionSec: 750 })} startAt={750} nonce={1} onBack={vi.fn()} />,
    );
    expect(screen.getByTestId("player-stub")).toBeTruthy();

    rerender(<Lesson state={fakeState()} lesson={lesson({ positionSec: 750 })} startAt={0} nonce={2} onBack={vi.fn()} />);
    expect(screen.queryByTestId("player-stub")).toBeNull();
    expect(screen.getByRole("button", { name: t.videoLabel("Наполеон") })).toBeTruthy();
  });
});


describe("online cached playback authorization", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  function savedState() {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: {} } });
    return { ...fakeState(), view: { speed: true }, offline: { l1: { photos: 0 } } } as unknown as CourseState;
  }
  it("never uses a cached copy after server denial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    render(<Lesson state={savedState()} lesson={lesson()} startAt={10} nonce={1} onBack={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toContain("/api/course/");
  });
  it("checks access, uses cache, then lets the student request online quality", async () => {
    const fetcher = vi.fn(async () => ({ ok: true }));vi.stubGlobal("fetch", fetcher);
    render(<Lesson state={savedState()} lesson={lesson()} startAt={10} nonce={1} onBack={vi.fn()} />);
    expect(screen.queryByTestId("player-stub")).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "include" });
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toBe("/offline/manifest/l1");
    fireEvent.click(screen.getByRole("button", { name: t.onlineQuality }));
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toContain("/api/course/");
  });
  it("does not attempt cache playback without a controlling service worker", async () => {
    const state = savedState();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: null } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<Lesson state={state} lesson={lesson()} startAt={10} nonce={1} onBack={vi.fn()} />);
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toContain("/api/course/");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("falls back once to protected streaming when a cached segment is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    render(<Lesson state={savedState()} lesson={lesson()} startAt={10} nonce={1} onBack={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toBe("/offline/manifest/l1");
    fireEvent.click(screen.getByText("fail"));
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toContain("/api/course/");
  });
  it("times out a hanging authorization and falls back to the protected network path", async () => {
    vi.useFakeTimers();vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Lesson state={savedState()} lesson={lesson()} startAt={10} nonce={1} onBack={vi.fn()} />);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("player-stub").getAttribute("data-src")).toContain("/api/course/");
  });
});
