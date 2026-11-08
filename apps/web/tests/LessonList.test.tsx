import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LessonList } from "../src/course/components/LessonList";
import { dict } from "../src/course/i18n";
import type { CourseInfo, LessonView } from "../src/course/api";

afterEach(cleanup);

const t = dict("ru");

function lesson(id: string, over: Partial<LessonView> = {}): LessonView {
  return {
    id,
    title: `Урок ${id}`,
    durationSec: 600,
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

function course(over: Partial<CourseInfo> = {}): CourseInfo {
  return {
    id: "c1",
    code: "COURSE",
    title: "Курс",
    description: null,
    purchaseId: null,
    modules: [
      { id: "m1", title: "Раздел 1", lessons: [lesson("l1", { completed: true, percent: 100 }), lesson("l2")] },
      { id: "m2", title: "Раздел 2", lessons: [lesson("l3")] },
    ],
    ...over,
  };
}

/**
 * СЕТКА (визуальная система 04.09.2026, §3): номер на карточке — по всему
 * курсу, не по разделу; следующий непройденный урок в этом порядке — во всю
 * ширину сетки.
 */
describe("LessonList — журнальная сетка", () => {
  it("нумерует уроки по всему курсу насквозь, не с нуля в каждом разделе", () => {
    const { container } = render(
      <LessonList t={t} lang="ru" course={course()} offline={{}} saving={{}} online onOpen={vi.fn()} />,
    );
    const numbers = Array.from(container.querySelectorAll(".lesson-num")).map((n) => n.textContent);
    // первый урок пройден — вместо номера галочка
    expect(numbers).toEqual(["", "02", "03"]);
  });

  it("курс без материалов — пустое состояние, а не пустая сетка", () => {
    render(
      <LessonList t={t} lang="ru" course={course({ comingSoon: true })} offline={{}} saving={{}} online onOpen={vi.fn()} />,
    );
    expect(screen.getByText(t.courseComingSoon)).toBeTruthy();
  });
});
