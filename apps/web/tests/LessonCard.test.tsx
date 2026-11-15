import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LessonCard } from "../src/course/components/LessonCard";
import { dict } from "../src/course/i18n";
import type { LessonView } from "../src/course/api";

afterEach(cleanup);

const t = dict("ru");

function lesson(over: Partial<LessonView> = {}): LessonView {
  return {
    id: "l1",
    title: "Наполеон",
    durationSec: 720,
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
 * ОДИН ТАП. Раньше начатый урок открывал окно «продолжить или сначала» — два
 * нажатия, и Android закрывал модалку кнопкой «назад» вместе с приложением.
 *
 * Карточка (журнальная сетка, §3 визуальной системы) сменила разметку строки
 * 96×54, но не поведение: те же чипы, тот же aria-label, тот же офлайн-фолбэк.
 */
describe("LessonCard", () => {
  it("начатый урок: чипы «Продолжить с 12:30» и «Сначала» прямо на карточке", () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <LessonCard t={t} lesson={lesson({ positionSec: 750, percent: 40 })} number={1} online onOpen={onOpen} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Продолжить с 12:30/ }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "l1" }), 750);
    fireEvent.click(screen.getByRole("button", { name: "Сначала" }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "l1" }), 0);
  });

  it("тап по самой карточке начатого урока продолжает с сохранённой секунды", () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <LessonCard t={t} lesson={lesson({ positionSec: 100, percent: 10 })} number={1} online onOpen={onOpen} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Наполеон/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), 100);
  });

  it("не начатый и досмотренный — без чипов, открывается с начала", () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <LessonCard t={t} lesson={lesson()} number={1} online onOpen={onOpen} />
        <LessonCard
          t={t}
          lesson={lesson({ id: "l2", positionSec: 700, percent: 100, completed: true })}
          number={2}
          online
          onOpen={onOpen}
        />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "Сначала" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Наполеон, 12 мин/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), 0);
  });

  it("без интернета несохранённый урок отключён и объясняет почему", () => {
    render(
      <ul>
        <LessonCard t={t} lesson={lesson()} number={1} online={false} onOpen={() => undefined} />
      </ul>,
    );
    const card = screen.getByRole("button", { name: /Наполеон/ }) as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.getAttribute("aria-label")).toContain(t.notSavedHint);
  });

  it("сохранённый урок открывается и без сети, с чипом «в телефоне»", () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <LessonCard
          t={t}
          lesson={lesson()}
          number={1}
          online={false}
          saved={{ lessonId: "l1", title: "Наполеон", segments: 3, bytes: 1, savedAt: 1, lastUsedAt: 1, completed: false } as never}
          onOpen={onOpen}
        />
      </ul>,
    );
    const card = screen.getByRole("button", { name: /Наполеон/ }) as HTMLButtonElement;
    expect(card.disabled).toBe(false);
    expect(screen.getByText(t.savedChip)).toBeTruthy();
  });

  it("номер урока — в круге слева с ведущим нулём", () => {
    const { container } = render(
      <ul>
        <LessonCard t={t} lesson={lesson()} number={3} online onOpen={() => undefined} />
      </ul>,
    );
    expect(container.querySelector(".lesson-num")?.textContent).toBe("03");
    expect(container.querySelector("img")).toBeNull();
  });

  it("пройденный урок: в круге галочка вместо номера", () => {
    const { container } = render(
      <ul>
        <LessonCard t={t} lesson={lesson({ completed: true, percent: 100 })} number={1} online onOpen={() => undefined} />
      </ul>,
    );
    expect(container.querySelector(".lesson-num.is-done svg")).toBeTruthy();
  });

  it("начатый, но не пройденный урок — тонкая полоска прогресса", () => {
    const { container } = render(
      <ul>
        <LessonCard t={t} lesson={lesson({ percent: 40, positionSec: 300 })} number={1} online onOpen={() => undefined} />
      </ul>,
    );
    const bar = container.querySelector(".lesson-progress-line > span") as HTMLElement | null;
    expect(bar?.style.width).toBe("40%");
  });
});
