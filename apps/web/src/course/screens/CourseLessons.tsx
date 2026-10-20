import type { CourseInfo, LessonView } from "../api";
import { AskFab } from "../components/AskFab";
import { Banner } from "../components/Banner";
import { LessonList } from "../components/LessonList";
import type { CourseState } from "../hooks/useCourse";
import { BackButton } from "./BackButton";
import { ToolGlyph } from "./ToolsScreen";

/** Уроки одного курса — экран для тех, у кого курсов два. */
export function CourseLessons({
  state,
  course,
  onBack,
  onOpenLesson,
  onOpenChat,
  onOpenTools,
}: {
  state: CourseState;
  course: CourseInfo;
  onBack: () => void;
  onOpenLesson: (lesson: LessonView, startAt: number) => void;
  onOpenChat: () => void;
  onOpenTools: (course: CourseInfo) => void;
}) {
  const { t, lang, view, offline, saving, online, source } = state;
  return (
    <div className="page has-fab">
      <header className="topbar">
        <BackButton t={t} onClick={onBack} />
        <h1 className="topbar-title">{course.title}</h1>
      </header>
      {course.description && <p className="sub">{course.description}</p>}
      {(course.toolsData?.length ?? 0) > 0 && (
        <button type="button" className="tools-entry" onClick={() => onOpenTools(course)}>
          <ToolGlyph /> {t.toolsLink}
        </button>
      )}
      {!online && <Banner text={t.offlineBadge} />}
      {online && source === "cache" && <Banner text={t.cachedCopy} tone="info" />}
      <LessonList
        t={t}
        lang={lang}
        course={course}
        profile={view?.profile}
        offline={offline}
        saving={saving}
        online={online}
        onOpen={onOpenLesson}
      />
      <AskFab t={t} onClick={onOpenChat} />
    </div>
  );
}
