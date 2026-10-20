import type { Dict } from "../i18n";

/**
 * ПОДСКАЗКА О ЖЕСТАХ — один раз, при первом открытии плеера. Жесты «как в
 * YouTube» знают не все: часть учениц старше, часть видео смотрит только в
 * Instagram, где зажатие — это пауза. Три строки с картинками, любое касание
 * закрывает. Вся подсказка — одна кнопка: с TalkBack её прочитают целиком и
 * закроют тем же касанием.
 */
export function Hint({ t, onDismiss }: { t: Dict; onDismiss: () => void }) {
  return (
    <button type="button" className="player-hint" onClick={onDismiss} aria-label={t.hintDismiss}>
      <span className="player-hint-row">
        <HoldGlyph />
        <span>{t.hintHold}</span>
      </span>
      <span className="player-hint-row">
        <DoubleTapGlyph />
        <span>{t.hintDoubleTap}</span>
      </span>
      <span className="player-hint-row">
        <ButtonsGlyph />
        <span>{t.hintButtons}</span>
      </span>
      <span className="player-hint-ok">{t.hintDismiss}</span>
    </button>
  );
}

function HoldGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="14" cy="14" r="4" fill="currentColor" />
    </svg>
  );
}
function DoubleTapGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <circle cx="14" cy="14" r="4" fill="currentColor" />
      <circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}
function ButtonsGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="3" y="17" width="22" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="6" y="20" width="5" height="2" fill="currentColor" />
      <rect x="13" y="20" width="9" height="2" fill="currentColor" />
    </svg>
  );
}
