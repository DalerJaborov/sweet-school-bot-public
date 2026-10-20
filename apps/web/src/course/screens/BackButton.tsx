import type { Dict } from "../i18n";

/** Кнопка «назад» в шапке экрана: 48px, стрелка плюс слово — одной стрелки
 *  человеку, впервые увидевшему приложение, мало. */
export function BackButton({ t, onClick }: { t: Dict; onClick: () => void }) {
  return (
    <button type="button" className="back-btn" onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M12 3 5 10l7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {t.back}
    </button>
  );
}
