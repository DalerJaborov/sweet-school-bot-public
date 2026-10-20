import { ChatThread } from "../chat/ChatThread";
import type { CourseState } from "../hooks/useCourse";
import { useVisualViewport } from "../hooks/useVisualViewport";
import { BackButton } from "./BackButton";

/**
 * ЧАТ — СТРАНИЦА, А НЕ ЛИСТ (03.09.2026). Фиксированный лист на iPhone
 * закрывался клавиатурой: поле ввода уезжало под неё. Страница растягивается
 * на настоящую видимую высоту (visualViewport), композер прижат к низу, и
 * кнопка «назад» на Android ведёт к урокам, а не закрывает приложение.
 */
export function ChatPage({ state, lessonId, onBack }: { state: CourseState; lessonId: string | null; onBack: () => void }) {
  const { t, online } = state;
  const height = useVisualViewport();
  return (
    <div className="page chat-page" style={height ? { height: `${height}px` } : undefined}>
      <header className="topbar">
        <BackButton t={t} onClick={onBack} />
        <h1 className="topbar-title">{t.chatTitle}</h1>
      </header>
      <ChatThread t={t} lessonId={lessonId} online={online} />
    </div>
  );
}
