import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LessonHero } from "../src/course/components/LessonHero";
import { dict } from "../src/course/i18n";
import type { LessonView } from "../src/course/api";

afterEach(() => {
  cleanup();
  // @ts-expect-error — точечно убираем то, что точечно добавили в тестах ниже.
  delete navigator.share;
  // @ts-expect-error
  delete navigator.canShare;
});

const t = dict("ru");

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

/**
 * ГЕРОЙСКИЙ ЭКРАН УРОКА (визуальная система 04.09.2026, §4): тизер/обложка в
 * рамке 9:16 до первого воспроизведения, тап или кнопка «Начать · N мин»
 * переводит к плееру (переключение живёт в Lesson.tsx — здесь только сам
 * компонент и цепочка фолбэков обложки).
 */
describe("LessonHero", () => {
  it("есть тизер — автоплей-видео без звука, поверх кнопка «Начать · N мин»", () => {
    const onStart = vi.fn();
    const { container } = render(
      <LessonHero t={t} lesson={lesson({ teaserUrl: "https://x/teaser.mp4", storyUrl: "https://x/story.jpg" })} onStart={onStart} />,
    );
    const video = container.querySelector("video") as HTMLVideoElement | null;
    expect(video).toBeTruthy();
    expect(video?.muted).toBe(true);
    expect(video?.hasAttribute("loop")).toBe(true);
    expect(video?.hasAttribute("autoplay")).toBe(true);
    expect(video?.getAttribute("poster")).toBe("https://x/story.jpg");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Начать · 24 мин")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t.videoLabel("Наполеон") }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("тизера нет, но есть storyUrl — статичная сторис-обложка, без video", () => {
    const { container } = render(<LessonHero t={t} lesson={lesson({ storyUrl: "https://x/story.jpg" })} onStart={() => undefined} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x/story.jpg");
  });

  it("storyUrl нет — падает на coverUrl", () => {
    const { container } = render(
      <LessonHero t={t} lesson={lesson({ coverUrl: "https://x/cover.jpg", posterUrl: "https://x/poster.jpg" })} onStart={() => undefined} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x/cover.jpg");
  });

  it("ни storyUrl, ни coverUrl — падает на posterUrl", () => {
    const { container } = render(<LessonHero t={t} lesson={lesson({ posterUrl: "https://x/poster.jpg" })} onStart={() => undefined} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x/poster.jpg");
  });

  it("совсем без обложки — плейсхолдер, а не сломанная картинка", () => {
    const { container } = render(<LessonHero t={t} lesson={lesson()} onStart={() => undefined} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".lesson-hero-ph")).toBeTruthy();
  });

  it("без storyUrl кнопки «Поделиться» нет вовсе — делиться нечем", () => {
    render(<LessonHero t={t} lesson={lesson({ coverUrl: "https://x/cover.jpg" })} onStart={() => undefined} />);
    expect(screen.queryByRole("button", { name: t.heroShare })).toBeNull();
  });

  it("Поделиться, Web Share с файлами недоступен — честно открывает story.jpg новой вкладкой", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<LessonHero t={t} lesson={lesson({ storyUrl: "https://x/story.jpg" })} onStart={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: t.heroShare }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://x/story.jpg", "_blank", "noopener"));
  });

  it("Поделиться, Web Share с файлами доступен — уходит в системный лист, без window.open", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["jpg"], { type: "image/jpeg" }), { status: 200 })));
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });

    render(<LessonHero t={t} lesson={lesson({ storyUrl: "https://x/story.jpg", title: "Наполеон" })} onStart={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: t.heroShare }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "Наполеон" }));
    expect(open).not.toHaveBeenCalled();
  });
});
