import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CourseApp } from "./CourseApp";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { initTheme } from "./theme";
import "./course.css";

/**
 * Точка входа приложения ученицы. Отдельная от панели: у них разные люди,
 * разный вид и разный вход (панель — пароль, платформа — ссылка из переписки).
 * Общее только сборка и компонент, ловящий падения.
 */
// Тема — до рендера, чтобы тёмный экран не мигал белым при перезагрузке.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <CourseApp />
    </ErrorBoundary>
  </StrictMode>
);
