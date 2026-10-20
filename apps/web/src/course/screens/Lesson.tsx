import { useEffect, useState } from "react";
import { lessonsOf, manifestUrl, type LessonView } from "../api";
import { ChatThread } from "../chat/ChatThread";
import { LessonHero } from "../components/LessonHero";
import { RecipeCard } from "../components/RecipeCard";
import { panelId, tabId, Tabs } from "../components/Tabs";
import type { CourseState, ProgressVia } from "../hooks/useCourse";
import { offlineUrls } from "../offline";
import { Player } from "../player/Player";
import { BackButton } from "./BackButton";

/**
 * ЭКРАН УРОКА: плеер липкий сверху (рецепт листается, видео остаётся перед
 * глазами), под ним строка состояния и вкладки Рецепт | Фото | Вопрос.
 * «Вопрос» — тот же чат, но с привязкой к уроку: владелец в панели видит, о
 * чём спрашивают.
 */
export function Lesson({
  state,
  lesson,
  startAt,
  nonce,
  onBack,
}: {
  state: CourseState;
  lesson: LessonView;
  startAt: number;
  nonce: number;
  onBack: () => void;
}) {
  const { t, view, courses, offline, saving, online, reportProgress } = state;
  // Порядковый номер урока в курсе — для жёлтой плашки карточки рецепта
  // («ДАРСИ N»/«УРОК N»): тот же способ счёта, что у обложки в сетке уроков
  // (LessonList.tsx) — от общего плоского списка курса, а не по разделу.
  const lessonCourse = courses.find((c) => lessonsOf(c).some((l) => l.id === lesson.id));
  const lessonNumber = lessonCourse ? lessonsOf(lessonCourse).findIndex((l) => l.id === lesson.id) + 1 : 1;
  const [tab, setTab] = useState<"recipe" | "photos" | "question">("recipe");
  // Геройский экран (§4 визуальной системы) — только для свежего открытия
  // (startAt === 0): «Продолжить с 12:30» с карточки урока должно оставаться
  // одним тапом, а не два (тизер, потом ещё «Начать»).
  const [heroDismissed, setHeroDismissed] = useState(startAt > 0);
  useEffect(() => {
    setHeroDismissed(startAt > 0);
  }, [lesson.id, nonce, startAt]);
  const saved = offline[lesson.id];
  const savingPercent = saving[lesson.id];
  const useOffline = !online && Boolean(saved);

  // Без сети играем из телефона; с сетью — обычным путём, чтобы качество
  // подстраивалось под скорость (в сохранённой копии только 480p).
  const src = useOffline ? offlineUrls.manifest(lesson.id) : manifestUrl(lesson.id);
  const photos = useOffline
    ? Array.from({ length: saved?.photos ?? 0 }, (_, i) => offlineUrls.photo(lesson.id, i))
    : lesson.recipePhotos;

  const stateLine =
    savingPercent !== undefined
      ? t.savingLesson(savingPercent)
      : saved
        ? t.savedLesson
        : online
          ? t.willSave
          : t.noInternet;

  const onProgress = (pos: number, pct: number, via: ProgressVia) => reportProgress(lesson, pos, pct, via);

  const tabs = [
    { id: "recipe", label: t.recipe },
    { id: "photos", label: t.photos },
    { id: "question", label: t.question },
  ];

  return (
    <div className="page lesson-page">
      <header className="topbar">
        <BackButton t={t} onClick={onBack} />
        <h1 className="topbar-title">{lesson.title}</h1>
      </header>

      <div className="player-sticky">
        {heroDismissed ? (
          <Player
            t={t}
            src={src}
            title={lesson.title}
            watermark={view?.watermark || t.appName}
            startAt={startAt}
            nonce={nonce}
            showQuality={!useOffline}
            onProgress={onProgress}
          />
        ) : (
          <LessonHero t={t} lesson={lesson} onStart={() => setHeroDismissed(true)} />
        )}
      </div>

      <p className="lesson-state" role="status">
        {stateLine}
      </p>

      <Tabs prefix="lesson" tabs={tabs} active={tab} onChange={(id) => setTab(id as typeof tab)} label={lesson.title} />

      <div
        className="tabpanel"
        role="tabpanel"
        id={panelId("lesson", tab)}
        aria-labelledby={tabId("lesson", tab)}
        tabIndex={0}
      >
        {tab === "recipe" && (
          <RecipeCard
            t={t}
            title={lesson.title}
            number={lessonNumber}
            recipeData={lesson.recipeData ?? null}
            fallbackText={lesson.recipeText}
          />
        )}
        {tab === "photos" &&
          (photos.length > 0 ? (
            <div className="photos">
              {photos.map((url) => (
                <img key={url} src={url} alt="" loading="lazy" decoding="async" />
              ))}
            </div>
          ) : (
            <p className="muted">{t.noPhotos}</p>
          ))}
        {tab === "question" && <ChatThread t={t} lessonId={lesson.id} online={online} />}
      </div>
    </div>
  );
}
