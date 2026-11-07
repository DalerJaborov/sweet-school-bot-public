import type { Dict } from "../i18n";

export function StudentNav({ t, onQuestion, onTools }: { t: Dict; onQuestion: () => void; onTools?: () => void }) {
  return (
    <nav className="student-nav" aria-label={t.yourCourses}>
      <button type="button" aria-current="page" onClick={() => window.scrollTo({ top: 0, behavior: "instant" })}>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
        {t.yourCourses}
      </button>
      {onTools && (
        <button type="button" onClick={onTools}>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 8h16l-2 12H6L4 8ZM8 8V6a4 4 0 0 1 8 0v2" />
          </svg>
          {t.toolsLink}
        </button>
      )}
      <button type="button" onClick={onQuestion}>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 4h16v13H9l-5 4V4Z" />
        </svg>
        {t.question}
      </button>
    </nav>
  );
}
