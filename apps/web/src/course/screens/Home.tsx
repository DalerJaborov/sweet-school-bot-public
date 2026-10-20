import type { CourseInfo, LessonView } from "../api";
import { AskFab } from "../components/AskFab";
import { Avatar } from "../components/Avatar";
import { Banner } from "../components/Banner";
import { ContactsBlock } from "../components/ContactsBlock";
import { CourseCard } from "../components/CourseCard";
import { InstallCard } from "../components/InstallCard";
import { LanguageToggle } from "../components/LanguageToggle";
import { LessonList } from "../components/LessonList";
import { StorageNote } from "../components/StorageNote";
import { ThemeToggle } from "../components/ThemeToggle";
import type { CourseState } from "../hooks/useCourse";
import type { Lang } from "../i18n";
import { useTheme } from "../theme";
import { ToolGlyph } from "./ToolsScreen";

/**
 * ГЛАВНАЯ. Ссылка из переписки открывает её, а не видео (решение владельца
 * 03.09.2026): автозапуск урока с сохранённой секунды означал бы, что в тишине
 * комнаты вдруг заиграл звук неизвестно какого урока.
 *
 * Два курса — две карточки; один — сразу уроки, без лишнего экрана.
 * Шапка (дизайн 03.09.2026): кружок с буквой имени, справа — тема и язык,
 * ниже — крупное приветствие.
 */
export function Home({
  state,
  onOpenCourse,
  onOpenLesson,
  onOpenChat,
  onOpenTools,
  onLanguage,
}: {
  state: CourseState;
  onOpenCourse: (course: CourseInfo) => void;
  onOpenLesson: (lesson: LessonView, startAt: number) => void;
  onOpenChat: () => void;
  onOpenTools: (course: CourseInfo) => void;
  onLanguage: (lang: Lang) => void;
}) {
  const { t, lang, view, courses, offline, saving, online, source } = state;
  const { theme, toggle } = useTheme();
  const name = view?.profile?.firstName?.trim();
  const single = courses.length === 1 ? courses[0] : null;

  return (
    <div className="page has-fab">
      <header className="page-head">
        <div className="page-head-row">
          <Avatar name={name} />
          <div className="page-head-tools">
            <ThemeToggle t={t} theme={theme} onToggle={toggle} />
            <LanguageToggle t={t} lang={lang} onChange={onLanguage} />
          </div>
        </div>
        <h1 className="greeting">{name ? t.greeting(name) : t.greetingNoName}</h1>
        {single && <p className="sub">{single.description ?? single.title}</p>}
      </header>

      {!online && <Banner text={t.offlineBadge} />}
      {online && source === "cache" && <Banner text={t.cachedCopy} tone="info" />}

      {single ? (
        <>
          {(single.toolsData?.length ?? 0) > 0 && (
            <button type="button" className="tools-entry" onClick={() => onOpenTools(single)}>
              <ToolGlyph /> {t.toolsLink}
            </button>
          )}
          <LessonList
            t={t}
            lang={lang}
            course={single}
            profile={view?.profile}
            offline={offline}
            saving={saving}
            online={online}
            onOpen={onOpenLesson}
          />
        </>
      ) : (
        <section aria-labelledby="courses-h">
          <h2 id="courses-h" className="section-h">
            {t.yourCourses}
          </h2>
          <div className="course-cards">
            {courses.map((course, i) => (
              <CourseCard key={course.id} t={t} course={course} onOpen={onOpenCourse} hero={i === 0} />
            ))}
          </div>
        </section>
      )}

      <InstallCard t={t} />
      <ContactsBlock t={t} school={view?.school} />
      <StorageNote t={t} />

      <AskFab t={t} onClick={onOpenChat} />
    </div>
  );
}
