import { lessonsOf, type CourseInfo, type CourseProfile, type LessonView } from "../api";
import type { Dict, Lang } from "../i18n";
import type { OfflineLesson } from "../offline";
import { CertificateCard } from "./CertificateCard";
import { LessonCard } from "./LessonCard";

/**
 * Уроки курса по разделам. Заголовок раздела — только когда разделов больше
 * одного: единственный «Раздел 1» над списком лишь занимает место.
 *
 * Над списком — сертификат: карточка, когда курс пройден целиком, иначе одна
 * строка «пройдено 3 из 12» с полоской (обещать сертификат до финиша нечем).
 *
 * СЕТКА (визуальная система 04.09.2026, scratchpad/visual-ideas.md §3): номер
 * на обложке карточки — порядковый по всему курсу, а не по разделу, поэтому
 * считаем его от общего плоского списка уроков (lessonsOf). Первый непройденный
 * урок в этом же порядке получает карточку на всю ширину сетки, с автоплеем
 * тизера, если он есть.
 */
export function LessonList({
  t,
  lang,
  course,
  profile,
  offline,
  saving,
  online,
  onOpen,
}: {
  t: Dict;
  lang: Lang;
  course: CourseInfo;
  profile?: CourseProfile;
  offline: Record<string, OfflineLesson | undefined>;
  saving: Record<string, number>;
  online: boolean;
  onOpen: (lesson: LessonView, startAt: number) => void;
}) {
  if (course.comingSoon) {
    return <p className="empty-state">{t.courseComingSoon}</p>;
  }
  const many = course.modules.length > 1;
  const cert = course.certificate;
  const percent = cert && cert.total ? Math.round((cert.done / cert.total) * 100) : 0;

  const ordered = lessonsOf(course);
  const numberById = new Map(ordered.map((lesson, i) => [lesson.id, i + 1]));
  const nextId = ordered.find((lesson) => !lesson.completed)?.id;

  return (
    <>
      {cert &&
        (cert.eligible ? (
          <CertificateCard t={t} lang={lang} courseId={course.id} certificate={cert} profile={profile} />
        ) : (
          <p className="course-progress">
            <span className="course-progress-bar" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
            <span>{t.passedOf(cert.done, cert.total)}</span>
          </p>
        ))}
      {course.modules.map((module) => (
        <section key={module.id} className="module" aria-label={many ? module.title : undefined}>
          {many && <h2 className="module-h">{module.title}</h2>}
          <ul className="lessons">
            {module.lessons.map((lesson) => (
              <LessonCard
                key={lesson.id}
                t={t}
                lesson={lesson}
                number={numberById.get(lesson.id) ?? 1}
                isNext={lesson.id === nextId}
                saved={offline[lesson.id]}
                savingPercent={saving[lesson.id]}
                online={online}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
