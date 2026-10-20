import { lessonsOf, type CourseInfo } from "../api";
import type { Dict } from "../i18n";
import { ProgressRing } from "./ProgressRing";

/**
 * Карточка курса на Главной — только когда курсов два (купила оба). С одним
 * курсом лишний экран между входом и уроком ни к чему, и список уроков
 * показывается сразу.
 *
 * Дизайн 03.09.2026: «геройская» карточка — малиновый градиент, белый текст,
 * крупное кольцо прогресса справа. Первая карточка — акцентная, вторая —
 * белая с тенью: два одинаковых ярких пятна друг под другом спорили бы.
 */
export function CourseCard({
  t,
  course,
  onOpen,
  hero = true,
}: {
  t: Dict;
  course: CourseInfo;
  onOpen: (course: CourseInfo) => void;
  hero?: boolean;
}) {
  const lessons = lessonsOf(course);
  const done = lessons.filter((l) => l.completed).length;
  const percent = lessons.length ? Math.round((done / lessons.length) * 100) : 0;
  return (
    <button
      type="button"
      className={hero ? "course-card hero" : "course-card"}
      onClick={() => onOpen(course)}
      aria-label={t.courseAria(course.title, done, lessons.length)}
    >
      <span className="course-card-body">
        <span className="course-card-kicker">{t.lessonsCount(lessons.length)}</span>
        <span className="course-card-title">{course.title}</span>
        {course.description && <span className="course-card-desc">{course.description}</span>}
        <span className="course-card-open">{t.openCourse} →</span>
      </span>
      <span className="course-card-side">
        <ProgressRing percent={percent} completed={lessons.length > 0 && done === lessons.length} size={64} />
        <span className="course-card-meta">{t.passedOf(done, lessons.length)}</span>
      </span>
    </button>
  );
}
