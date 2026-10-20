import type { LessonView } from "../api";
import { formatDuration, formatTime, type Dict } from "../i18n";
import { offlineUrls, type OfflineLesson } from "../offline";

/**
 * КАРТОЧКА УРОКА В ЖУРНАЛЬНОЙ СЕТКЕ (визуальная система 04.09.2026,
 * scratchpad/visual-ideas.md §3, заменяет старую строку 96×54 — см.
 * git-историю LessonRow.tsx).
 *
 * Раньше начатый урок открывал окно «продолжить или сначала» — два нажатия
 * вместо одного, и модалка, которую Android закрывал кнопкой «назад» вместе с
 * приложением. Выбор — прямо на карточке: чип «Продолжить с 12:30» и
 * «Сначала». Сама карточка — одна кнопка с полным aria-label; чипы — отдельные
 * кнопки рядом (вложенных кнопок HTML не допускает).
 *
 * Тап по самой карточке начатого урока продолжает с сохранённой секунды: это
 * то, чего хотят чаще всего. «Сначала» — для тех, кто пересматривает шаг.
 *
 * ОБЛОЖКА. Три уровня: серверная coverUrl (номер и название уже впечатаны в
 * картинку — apps/api/src/storage/coverArt.ts) → posterUrl из транскода →
 * плейсхолдер. Большинство уроков сегодня ещё без coverUrl (бэкфил не
 * прогнан), это не редкий случай, а обычный — поэтому у плейсхолдера свой
 * фирменный вид, а не «сломанная картинка». Без сети coverUrl всё равно не
 * откроется (в офлайн-хранилище лежит только posterUrl, см. offline.ts), тогда
 * берём офлайн-постер, как раньше.
 */

/** Меньше этого начатый урок считаем случайным касанием: чипов не показываем. */
export const RESUME_AFTER_SEC = 20;

export type LessonCardProps = {
  t: Dict;
  lesson: LessonView;
  /** Порядковый номер урока в курсе (1-based) — печатается в углу обложки. */
  number: number;
  /** Следующий непройденный урок курса — карточка на всю ширину сетки, с тизером. */
  isNext?: boolean;
  saved?: OfflineLesson;
  savingPercent?: number;
  online: boolean;
  onOpen: (lesson: LessonView, startAt: number) => void;
};

export function LessonCard({
  t,
  lesson,
  number,
  isNext = false,
  saved,
  savingPercent,
  online,
  onOpen,
}: LessonCardProps) {
  const isSaved = Boolean(saved);
  const unavailable = !lesson.ready || (!online && !isSaved);
  const resumable = lesson.ready && !lesson.completed && lesson.positionSec >= RESUME_AFTER_SEC;
  const inProgress = lesson.ready && !lesson.completed && lesson.percent > 0;

  const note = !lesson.ready
    ? t.lessonPreparing
    : lesson.completed
      ? t.lessonDone
      : lesson.percent > 0
        ? t.lessonStopped(lesson.percent)
        : formatDuration(lesson.durationSec, t);
  const hint = !lesson.ready ? null : unavailable ? t.notSavedHint : null;

  const chip =
    savingPercent !== undefined ? t.savingChip(savingPercent) : isSaved ? t.savedChip : !lesson.ready ? null : null;

  const ariaLabel = [lesson.title, note, hint, chip].filter(Boolean).join(", ");

  // Без сети постер берём из телефона (SW отдаст его из IndexedDB) — coverUrl
  // там не лежит, поэтому онлайн-обложка используется только онлайн.
  const posterFallback = !online && saved?.poster ? offlineUrls.poster(lesson.id) : lesson.posterUrl;
  const cover = online ? (lesson.coverUrl ?? posterFallback) : posterFallback;
  const showTeaser = isNext && Boolean(lesson.teaserUrl) && !unavailable;
  const numberLabel = String(number).padStart(2, "0");

  return (
    <li className={["lesson-card", unavailable ? "off" : "", isNext ? "is-next" : ""].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="lesson-card-btn"
        disabled={unavailable}
        aria-label={ariaLabel}
        onClick={() => onOpen(lesson, resumable ? lesson.positionSec : 0)}
      >
        <span className={lesson.completed ? "lesson-cover is-done" : "lesson-cover"} aria-hidden="true">
          {showTeaser ? (
            <video
              className="lesson-cover-media"
              src={lesson.teaserUrl ?? undefined}
              poster={cover ?? undefined}
              muted
              autoPlay
              loop
              playsInline
            />
          ) : cover ? (
            <img src={cover} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="lesson-cover-ph">
              <PlayGlyph />
            </span>
          )}
          <span className="lesson-number">{numberLabel}</span>
          {lesson.completed && (
            <span className="lesson-ribbon">
              <CheckGlyph />
            </span>
          )}
          {inProgress && (
            <span className="lesson-progress" style={{ width: `${Math.max(0, Math.min(100, lesson.percent))}%` }} />
          )}
          {isNext && !showTeaser && <span className="lesson-eyebrow">{t.nextLesson}</span>}
        </span>
        <span className="lesson-card-body">
          <span className="lesson-title">{lesson.title}</span>
          <span className="lesson-pill">
            {note}
            {hint && <span className="lesson-hint"> · {hint}</span>}
          </span>
          {chip && <span className={isSaved && savingPercent === undefined ? "chip chip-ok" : "chip"}>{chip}</span>}
        </span>
      </button>

      {resumable && !unavailable && (
        <div className="lesson-chips">
          <button type="button" className="chip-btn primary" onClick={() => onOpen(lesson, lesson.positionSec)}>
            <PlayGlyph /> {t.continueFrom(formatTime(lesson.positionSec))}
          </button>
          <button type="button" className="chip-btn" onClick={() => onOpen(lesson, 0)}>
            {t.startOver}
          </button>
        </div>
      )}
    </li>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M2.5 7.5 5.5 10.5 11.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
