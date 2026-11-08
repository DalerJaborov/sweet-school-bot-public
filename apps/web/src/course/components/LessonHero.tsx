import { lessonPhoto } from "../lessonPhoto";
import { useState } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";
import type { LessonView } from "../api";
import { formatDuration, type Dict } from "../i18n";
import { shareOrOpenImage } from "../shareImage";

/** First-play preview uses the actual lesson photo. Existing branded story
 * artwork remains available for sharing; resuming a lesson skips this screen. */
export function LessonHero({ t, lesson, onStart }: { t: Dict; lesson: LessonView; onStart: () => void }) {
  const [sharing, setSharing] = useState(false);
  const reduceMotion = useReducedMotion();

  // Тот же порядок фолбэков, что у карточки урока в сетке: сторис → обложка →
  // Titles are accessible HTML; the image does not need baked-in decoration.
  const cover = lessonPhoto(lesson);
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
            autoPlay={!reduceMotion}
            preload={reduceMotion ? "none" : "metadata"}
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
