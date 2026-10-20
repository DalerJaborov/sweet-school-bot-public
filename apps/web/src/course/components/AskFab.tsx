import type { Dict } from "../i18n";

/**
 * Круглая кнопка вопроса учительнице — маленькая иконка вместо широкой
 * плашки «Спросить Ширин», которая закрывала номера и названия уроков в
 * новой сетке (владелец 05.09.2026). То же решение, что уже применено к
 * кнопке чата на публичном сайте: aria-label называет действие полностью,
 * на экране — только иконка.
 */
export function AskFab({ t, onClick }: { t: Dict; onClick: () => void }) {
  return (
    <button type="button" className="fab" aria-label={t.askTeacher} onClick={onClick}>
      <ChatGlyph />
    </button>
  );
}

function ChatGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="currentColor"
      />
    </svg>
  );
}
