import { useEffect } from "react";
import { endPreview } from "../api";
import type { Dict } from "../i18n";

/**
 * Полоса «Предпросмотр» поверх приложения ученицы — видна на каждом экране,
 * чтобы владелец ни на секунду не перепутал предпросмотр с живым кабинетом.
 * Высоту полосы получает переменная --safe-t (course.css, html.is-preview):
 * сдвигаются и страницы, и липкий плеер, ничего не перекрывается.
 */
export function PreviewStrip({ t }: { t: Dict }) {
  useEffect(() => {
    document.documentElement.classList.add("is-preview");
    return () => document.documentElement.classList.remove("is-preview");
  }, []);

  const exit = async () => {
    await endPreview().catch(() => undefined);
    // Вкладку открыла панель — закрываем её; если браузер не дал, уходим в панель.
    window.close();
    window.location.assign("/panel");
  };

  return (
    <div className="preview-strip" role="status">
      <span className="preview-badge">{t.previewBadge}</span>
      <span className="preview-note">{t.previewNote}</span>
      <button type="button" className="preview-exit" onClick={() => void exit()}>
        {t.previewExit}
      </button>
    </div>
  );
}
