import type { CourseInfo } from "../api";
import type { Dict } from "../i18n";
import { BackButton } from "./BackButton";

/**
 * ЭКРАН «НАБОР ИНСТРУМЕНТОВ» (визуальная система 04.09.2026, §5).
 *
 * Данные — Course.toolsData: список {name, photoUrl, toolNumber, buyLink},
 * который заполняет владелец в панели (CoursesPage.tsx), а не парсер импорта —
 * инструменты общие для всего курса, а не привязаны к одному уроку. Фото есть
 * не у всех — вместо сломанной картинки показываем плейсхолдер на
 * --c-accent-soft: инструмент без фото всё равно нужно узнать на полке
 * магазина, а не только по названию.
 */
export function ToolsScreen({ t, course, onBack }: { t: Dict; course: CourseInfo; onBack: () => void }) {
  const tools = course.toolsData ?? [];
  return (
    <div className="page">
      <header className="topbar">
        <BackButton t={t} onClick={onBack} />
        <h1 className="topbar-title">{t.toolsTitle}</h1>
      </header>

      {tools.length === 0 ? (
        <p className="empty-state">{t.noTools}</p>
      ) : (
        <ul className="tools-grid">
          {tools.map((tool, i) => (
            <li className="tool-card" key={`${tool.name}-${i}`}>
              <span className="tool-photo">
                {tool.photoUrl ? (
                  <img src={tool.photoUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="tool-photo-ph" role="img" aria-label={t.toolPhotoMissing}>
                    <ToolGlyph />
                  </span>
                )}
              </span>
              <span className="tool-name">{tool.name}</span>
              {tool.toolNumber && <span className="tool-number">{t.toolNumberLabel(tool.toolNumber)}</span>}
              {tool.buyLink && (
                <a className="tool-buy" href={tool.buyLink} target="_blank" rel="noreferrer noopener">
                  {t.buyInDushanbe}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Насадка-плейсхолдер — та же роль, что PlayGlyph/CheckGlyph в LessonCard:
 *  инструмент без фото не должен выглядеть как сломанная картинка. */
export function ToolGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14.7 6.3a3 3 0 0 1 4.2 4.2l-1 1L21 14.6 19.6 16l-3.1-3.1-1 1a3 3 0 0 1-4.2-4.2l.6-.6-4.2-4.2 1.4-1.4 4.2 4.2.6-.6ZM4 16l5-1 1 1-1 5-5 1-1-1 1-5Z"
        fill="currentColor"
      />
    </svg>
  );
}
