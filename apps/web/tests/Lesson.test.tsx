import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
  Player: ({ title }: { title: string }) => <div data-testid="player-stub">{title}</div>,
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
    lang: "ru",
    switchLanguage: vi.fn(),
    view: undefined,
    courses: [],
    offline: {},
    saving: {},
    online: true,
    reportProgress: vi.fn(),
  } as unknown as CourseState;
}

/** Экран урока: плеер сразу, без геройского экрана (решение владельца 08.11.2026). */
describe("Lesson — плеер сразу", () => {
  it("свежее открытие — сразу плеер, без промежуточного экрана", () => {
    render(<Lesson state={fakeState()} lesson={lesson()} startAt={0} nonce={1} onBack={vi.fn()} />);
    expect(screen.getByTestId("player-stub")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.videoLabel("Наполеон") })).toBeNull();
  });

  it("продолжение (startAt>0) — тоже плеер", () => {
    render(<Lesson state={fakeState()} lesson={lesson({ positionSec: 750 })} startAt={750} nonce={1} onBack={vi.fn()} />);
    expect(screen.getByTestId("player-stub")).toBeTruthy();
  });

  it("в шапке есть переключатели темы и языка", () => {
    render(<Lesson state={fakeState()} lesson={lesson()} startAt={0} nonce={1} onBack={vi.fn()} />);
    expect(screen.getByRole("group", { name: t.languageLabel })).toBeTruthy();
  });
});
