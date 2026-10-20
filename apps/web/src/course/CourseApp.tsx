import { Onboarding } from "./Onboarding";
import type { CourseInfo, LessonView } from "./api";
import { useCourse } from "./hooks/useCourse";
import { useScreen } from "./hooks/useScreen";
import { ChatPage } from "./screens/ChatPage";
import { CourseLessons } from "./screens/CourseLessons";
import { DeviceLimitScreen } from "./screens/DeviceLimitScreen";
import { EscapeInAppScreen } from "./screens/EscapeInAppScreen";
import { ErrorScreen } from "./screens/ErrorScreen";
import { environment } from "./install/detect";
import { Home } from "./screens/Home";
import { Lesson } from "./screens/Lesson";
import { Preparing, Splash } from "./screens/Splash";
import { ToolsScreen } from "./screens/ToolsScreen";

/**
 * ПРИЛОЖЕНИЕ УЧЕНИЦЫ — переключатель экранов.
 *
 * Данные (вход, /me, офлайн, прогресс, язык) — в hooks/useCourse; история
 * экранов — в hooks/useScreen (кнопка «назад» на Android ведёт домой, а не
 * закрывает приложение). Здесь только решение, какой экран показать:
 *
 *   Splash → (Onboarding, если нет языка) → Home
 *   Home ─(2 курса: карточка)─▶ CourseLessons ─(строка/чип)─▶ Lesson
 *   любой экран ─«Спросить»─▶ ChatPage
 *
 * Перед первым входом — знакомство: язык и имя (Onboarding.tsx). Офлайн
 * работает сам: досмотрела полминуты — урок фоном докачивается в телефон.
 * Кнопки «скачать» нет намеренно: лишний выбор на каждом уроке — лишний
 * повод растеряться (решения владельца 03.09.2026).
 */
export function CourseApp() {
  const state = useCourse();
  const { screen, go, back } = useScreen();
  const { view, error, t, courses, lessons } = state;

  // Раньше входа (дизайн доступа 03.09.2026): встроенный браузер выводим в
  // настоящий, лимит устройств — даём заменить старое, и только потом ошибки.
  if (state.inAppTrap) return <EscapeInAppScreen t={t} env={environment()} />;
  if (state.deviceLimit) {
    return <DeviceLimitScreen t={t} limit={state.deviceLimit} onReplace={() => void state.replaceOldestDevice()} />;
  }
  if (error) return <ErrorScreen t={t} error={error} onRetry={state.retry} school={view?.school} />;
  if (!view) return <Splash t={t} />;
  // Знакомство раньше уроков: имя нужно водяному знаку, язык — всему экрану.
  if (view.profile && !view.profile.language) return <Onboarding onDone={state.retry} />;
  if (!view.ready || courses.length === 0) return <Preparing t={t} />;

  const openLesson = (lesson: LessonView, startAt: number) => {
    state.noteOpened(lesson.id);
    // nonce — чтобы «Сначала» сработал и для уже открытого урока.
    go({ name: "lesson", lessonId: lesson.id, startAt, nonce: Date.now() });
  };
  const openChat = (lessonId: string | null = null) => go({ name: "chat", lessonId });
  const openTools = (course: CourseInfo) => go({ name: "tools", courseId: course.id });

  if (screen.name === "lesson") {
    const lesson = lessons.find((l) => l.id === screen.lessonId);
    if (lesson) {
      return <Lesson state={state} lesson={lesson} startAt={screen.startAt} nonce={screen.nonce} onBack={back} />;
    }
  }
  if (screen.name === "chat") return <ChatPage state={state} lessonId={screen.lessonId} onBack={back} />;
  if (screen.name === "tools") {
    const course = courses.find((c) => c.id === screen.courseId);
    if (course) return <ToolsScreen t={t} course={course} onBack={back} />;
  }
  if (screen.name === "course" && courses.length > 1) {
    const course = courses.find((c) => c.id === screen.courseId);
    if (course) {
      return (
        <CourseLessons
          state={state}
          course={course}
          onBack={back}
          onOpenLesson={openLesson}
          onOpenChat={() => openChat()}
          onOpenTools={openTools}
        />
      );
    }
  }
  return (
    <Home
      state={state}
      onOpenCourse={(course) => go({ name: "course", courseId: course.id })}
      onOpenLesson={openLesson}
      onOpenChat={() => openChat()}
      onOpenTools={openTools}
      onLanguage={(lang) => void state.switchLanguage(lang)}
    />
  );
}
