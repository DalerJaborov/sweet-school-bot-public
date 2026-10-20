import { useState } from "react";
import type { LessonView } from "../api";
import { formatDuration, type Dict } from "../i18n";
import { shareOrOpenImage } from "../shareImage";

/**
 * ГЕРОЙСКИЙ ЭКРАН УРОКА — до первого воспроизведения (визуальная система
 * 04.09.2026, scratchpad/visual-ideas.md §4): тизер без звука в скруглённой
 * рамке 9:16 (60vh) с малиновым свечением; тап или кнопка «Начать · N мин»
 * переводит на настоящий Player (см. Lesson.tsx). Если тизера нет — статичная
 * story-обложка, и так по цепочке фолбэков ниже.
 *
 * НОМЕР И НАЗВАНИЕ уже впечатаны сервером в саму картинку story/cover (см.
 * storage/coverArt.ts), а название вдобавок видно в шапке экрана урока —
 * поэтому здесь их не рисуем повторно, только то, чего на картинке нет:
 * тизер-видео и кнопку начать/поделиться.
 *
 * ОДИН ТАП ДЛЯ ПРОДОЛЖЕНИЯ. Lesson.tsx показывает этот экран только для
 * свежего открытия урока (startAt === 0); при «Продолжить с 12:30» с карточки
 * урока он пропускается — иначе восстановление позиции стоило бы лишнего
 * тапа, а это принцип, который уже защищает LessonCard.
 */
export function LessonHero({ t, lesson, onStart }: { t: Dict; lesson: LessonView; onStart: () => void }) {
  const [sharing, setSharing] = useState(false);

  // Тот же порядок фолбэков, что у карточки урока в сетке: сторис → обложка →
  // постер транскода → ничего (плейсхолдер), но самый вертикальный формат
  // (storyUrl) — первым: он и задуман под этот 9:16 экран.
  const cover = lesson.storyUrl ?? lesson.coverUrl ?? lesson.posterUrl ?? null;
  const hasTeaser = Boolean(lesson.teaserUrl);
  const ctaLabel = t.heroStartCta(formatDuration(lesson.durationSec, t));

  const share = async () => {
    if (!lesson.storyUrl || sharing) return;
    setSharing(true);
    try {
      await shareOrOpenImage(lesson.storyUrl, "story.jpg", { title: lesson.title });
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="lesson-hero">
      <button type="button" className="lesson-hero-frame" onClick={onStart} aria-label={t.videoLabel(lesson.title)}>
        {hasTeaser ? (
          <video
            className="lesson-hero-media"
            src={lesson.teaserUrl ?? undefined}
            poster={cover ?? undefined}
            muted
            autoPlay
            loop
            playsInline
          />
        ) : cover ? (
          <img className="lesson-hero-media" src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="lesson-hero-ph" aria-hidden="true">
            <PlayGlyph size={44} />
          </span>
        )}
        <span className="lesson-hero-overlay" aria-hidden="true">
          <span className="lesson-hero-play">
            <PlayGlyph size={26} />
          </span>
          <span className="lesson-hero-cta">{ctaLabel}</span>
        </span>
      </button>

      {lesson.storyUrl && (
        <div className="lesson-hero-actions">
          <button type="button" className="btn ghost" onClick={() => void share()} disabled={sharing}>
            <ShareGlyph /> {t.heroShare}
          </button>
        </div>
      )}
    </div>
  );
}

function PlayGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <path d="M11 6v24l20-12z" fill="currentColor" />
    </svg>
  );
}

/** Квадрат со стрелкой вверх — общий значок «Поделиться» в этом приложении. */
function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3v12m0-12 4.5 4.5M12 3 7.5 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
