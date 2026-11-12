import { useEffect, useState } from "react";
import { lessonsOf, manifestUrl, type LessonView } from "../api";
import { ChatThread } from "../chat/ChatThread";
import { LessonHero } from "../components/LessonHero";
import { RecipeCard } from "../components/RecipeCard";
import { panelId, tabId, Tabs } from "../components/Tabs";
import type { CourseState, ProgressVia } from "../hooks/useCourse";
import { offlineUrls } from "../offline";
import { mayPrefetch, playLocalFirst, swControlled } from "../speed";
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
  // Рубильник ускорения: сохранённый урок играет из памяти телефона и при
  // интернете («один раз загрузился — больше не грузится»). Если копия не
  // заиграла (срок истёк, сегмент потерян) — один раз падаем на сеть.
  const fast = view?.speed === true;
  const [localFailedFor, setLocalFailedFor] = useState<string | null>(null);
  const [localAccess, setLocalAccess] = useState<{ key: string; allowed: boolean } | null>(null);
  const [streamFor, setStreamFor] = useState<string | null>(null);
  const controlled = swControlled();
  const accessKey = `${lesson.id}:${nonce}`;
  useEffect(() => {
    setLocalAccess(null);
    if (!fast || !online || !saved || !controlled || streamFor === accessKey) return;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => {
      setLocalAccess({ key: accessKey, allowed: false });
      abort.abort();
    }, 5000);
    // Do not turn a cached offline lease into an online access bypass.
    // This endpoint checks the current device, purchase and revocation state.
    void fetch(manifestUrl(lesson.id), { credentials: "include", cache: "no-store", signal: abort.signal })
      .then((response) => { if (!abort.signal.aborted) setLocalAccess({ key: accessKey, allowed: response.ok }); })
      .catch(() => { if (!abort.signal.aborted) setLocalAccess({ key: accessKey, allowed: false }); })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); abort.abort(); };
  }, [fast, online, Boolean(saved), controlled, lesson.id, accessKey, streamFor]);
  const localFirst = playLocalFirst({
    fast,
    saved: Boolean(saved),
    swControlled: controlled,
    authorized: localAccess?.key === accessKey && localAccess.allowed,
    failed: localFailedFor === lesson.id || streamFor === accessKey,
  });
  const checkingLocal = fast && online && Boolean(saved) && controlled && streamFor !== accessKey && localAccess?.key !== accessKey;
  const useOffline = Boolean(saved) && (!online || localFirst);

  // A saved copy keeps its original quality; streaming retains adaptive quality.
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
          ? mayPrefetch() ? t.willSave : t.savingPaused
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
        {heroDismissed ? (checkingLocal ? <p role="status">{t.buffering}</p> :
          <Player
            t={t}
            src={src}
            title={lesson.title}
            watermark={view?.watermark || t.appName}
            startAt={startAt}
            nonce={nonce}
            showQuality={!useOffline}
            fast={fast}
            onFatalError={() => {
              if (useOffline && online) setLocalFailedFor(lesson.id);
            }}
            onProgress={onProgress}
          />
        ) : (
          <LessonHero t={t} lesson={lesson} onStart={() => setHeroDismissed(true)} />
        )}
      </div>

      {localFirst && online && <button type="button" className="btn" onClick={() => setStreamFor(accessKey)}>{t.onlineQuality}</button>}
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
        {tab === "recipe" && <>
          {(lesson.recipeData || lesson.recipeText || !photos.length) && <RecipeCard
            t={t}
            title={lesson.title}
            number={lessonNumber}
            recipeData={lesson.recipeData ?? null}
            fallbackText={lesson.recipeText}
          />}
          {photos.length > 0 && <section className="recipe-originals" aria-label={t.photos}>
            <h2>{t.photos}</h2>
            <div className="photos">{photos.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener"><img src={url} alt={`${lesson.title} · ${index + 1}`} loading="lazy" decoding="async" /></a>)}</div>
          </section>}
        </>}
        {tab === "photos" &&
          (photos.length > 0 ? (
            <div className="photos">
              {photos.map((url) => (
                <img key={url} src={url} alt={lesson.title} loading="lazy" decoding="async" />
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
