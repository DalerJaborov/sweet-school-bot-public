import type { Dict } from "../i18n";
import type { Theme } from "../theme";

/**
 * Солнце/луна в шапке Главной — единственный способ включить тёмную тему
 * (см. theme.ts). Круглая кнопка 48px в ряд с переключателем языка; подпись
 * описывает действие, а не состояние: «Включить тёмную тему».
 */
export function ThemeToggle({ t, theme, onToggle }: { t: Dict; theme: Theme; onToggle: () => void }) {
  const dark = theme === "dark";
  const label = dark ? t.themeLight : t.themeDark;
  return (
    <button type="button" className="icon-btn" onClick={onToggle} aria-pressed={dark} aria-label={label} title={label}>
      {dark ? (
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
          <path
            d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}
