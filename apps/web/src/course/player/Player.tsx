import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Dict } from "../i18n";
import type { ProgressVia } from "../hooks/useCourse";
import { Controls } from "./Controls";
import { ErrorOverlay } from "./ErrorOverlay";
import { Hint } from "./Hint";
import { preloadMode } from "./network";
import { hintSeen, loadRate, markHintSeen, saveRate, type Rate } from "./prefs";
import { useFullscreen } from "./useFullscreen";
import { useGestures } from "./useGestures";
import { useHls } from "./useHls";
import { useWakeLock } from "./useWakeLock";
import { Watermark } from "./Watermark";

/**
 * ПЛЕЕР УРОКА.
 *
 * КАЧЕСТВО ПОДСТРАИВАЕТСЯ САМО — это HLS: в манифесте несколько дорожек, и
 * плеер переключается по фактической скорости связи, как на YouTube (тонкая
 * настройка — в useHls). Кнопка «Авто · 720p / 480p / …» — для тех, кто хочет
 * сэкономить трафик руками; ручной выбор живёт только до закрытия страницы.
 *
 * ЖЕСТЫ КАК В YOUTUBE (03.09.2026, см. useGestures): зажать — 2×, двойное
 * касание по краю — ±10 с, одно касание — кнопки. Зажатие меняет скорость
 * прямо у <video>, не трогая выбранную в меню: отпустил — вернулась она же.
 *
 * ПОЗИЦИЯ НЕ ТЕРЯЕТСЯ. Текущая секунда живёт в `posRef` из `timeupdate`.
 * Один эффект на `[src, startAt, nonce]`: сменился источник (пропала сеть →
 * играем из телефона) — возвращаемся на ту же секунду; пришёл новый `nonce`
 * (открыли урок заново, чип «Сначала») — идём на `startAt`.
 *
 * ПРОГРЕСС: раз в 10 секунд, плюс на паузе и в конце; когда страницу
 * сворачивают или закрывают — через sendBeacon (обычный fetch в этот момент
 * браузер вправе оборвать). `lastReport` сбрасывается при смене урока и после
 * перемотки, иначе после прыжка на 5 минут вперёд отчёт ждал бы ещё 10 секунд.
 *
 * СПИННЕР, А НЕ ОШИБКА: застревание буфера и ожидание данных (`waiting`) —
 * штатная жизнь на мобильной связи, показываем тихий кружок; оверлей с
 * «Попробовать снова» — только когда hls.js исчерпал свои повторы.
 *
 * ЗАЩИТА, ЧЕСТНО О ГРАНИЦАХ:
 *  • именной водяной знак дрейфует — работает всегда, и офлайн, и при съёмке
 *    экрана другой камерой; лежит в обёртке, поэтому виден и в полноэкране;
 *  • пауза, когда вкладку свернули, и запрет контекстного меню;
 *  • экран не гаснет, пока идёт видео (Wake Lock, см. useWakeLock);
 *  • вызов getDisplayMedia самой этой страницей ставит урок на паузу.
 *    Запись из ОС или другой вкладки браузер обнаруживать не позволяет.
 * Настоящая защита купленного файла — шифрование сегментов и срок ключа, они
 * на сервере. Здесь — то, что видно глазами.
 */

/** Как часто отправлять прогресс во время просмотра. */
const REPORT_EVERY_SEC = 10;
/** Через сколько прятать кнопки во время игры. */
const HIDE_CONTROLS_MS = 3000;
/** Скорость при зажатии — как в YouTube. */
export const HOLD_RATE = 2;
const SKIP_SEC = 10;

export type PlayerProps = {
  t: Dict;
  /** Манифест: сетевой или локальный /offline/manifest/<id>. */
  src: string;
  title: string;
  /** Подпись поверх видео: имя и номер, чтобы запись было видно кому принадлежит. */
  watermark: string;
  /** С какой секунды начать при новом `nonce`. */
  startAt: number;
  /** Меняется при каждом открытии урока — даже того же самого. */
  nonce: number;
  /** Скрыть выбор качества (офлайн — одна дорожка; нативный HLS — не умеет). */
  showQuality: boolean;
  onProgress: (positionSec: number, percent: number, via: ProgressVia) => void;
};

export function Player({ t, src, title, watermark, startAt, nonce, showQuality, onProgress }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(0);
  const lastReport = useRef(0);
  const lastNonce = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRateState] = useState<Rate>(loadRate);
  const [controlsShown, setControlsShown] = useState(true);
  const [captureBlocked, setCaptureBlocked] = useState(false);
  const [hint, setHint] = useState(() => !hintSeen());

  const hls = useHls(videoRef, src, posRef);
  const fs = useFullscreen(wrapperRef, videoRef);
  useWakeLock(videoRef, playing);

  const report = useCallback(
    (via: ProgressVia) => {
      const video = videoRef.current;
      if (!video || !video.duration || !Number.isFinite(video.duration)) return;
      lastReport.current = video.currentTime;
      onProgress(Math.floor(video.currentTime), Math.floor((video.currentTime / video.duration) * 100), via);
    },
    [onProgress]
  );

  // Куда встать после смены источника или нового открытия (см. заголовок).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reopened = lastNonce.current !== nonce;
    let target: number;
    if (reopened) {
      lastNonce.current = nonce;
      target = startAt;
      posRef.current = startAt;
    } else {
      target = posRef.current;
    }
    lastReport.current = target;
    setCurrent(target);
    // Смена источника на нуле — мотать некуда; новое открытие с нуля — это
    // «Сначала» на уже идущем уроке, и на ноль нужно встать явно.
    if (target <= 0 && !reopened) return;
    const seek = () => {
      // Сохранённая секунда у самых титров — начинаем с начала, а не с конца.
      if (video.duration && target >= video.duration - 5) return;
      video.currentTime = target;
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [src, startAt, nonce]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, [rate, src]);

  const setRate = useCallback((r: Rate) => {
    setRateState(r);
    saveRate(r);
  }, []);

  // Свернули вкладку — пауза и отчёт маяком. Заодно бережёт трафик: видео не
  // качается в фоне, когда его никто не смотрит.
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      videoRef.current?.pause();
      report("beacon");
    };
    const onPageHide = () => report("beacon");
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [report]);

  // This only observes capture initiated by this page. It cannot detect OS
  // recorders or getDisplayMedia calls in other tabs; the watermark remains
  // the visible deterrent. Android's native wrapper separately uses FLAG_SECURE.
  useEffect(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    const original = media?.getDisplayMedia;
    if (!media || !original) return;
    media.getDisplayMedia = async function patched(...args: Parameters<MediaDevices["getDisplayMedia"]>) {
      setCaptureBlocked(true);
      videoRef.current?.pause();
      return original.apply(this, args);
    };
    return () => {
      media.getDisplayMedia = original;
    };
  }, []);

  // Кнопки прячутся сами во время игры и показываются от касания.
  const poke = useCallback(() => {
    setControlsShown(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControlsShown(false);
    }, HIDE_CONTROLS_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    []
  );

  const playPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    poke();
  }, [poke]);

  const seekTo = useCallback(
    (sec: number) => {
      const video = videoRef.current;
      if (!video) return;
      const max = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      const next = Math.max(0, Math.min(sec, max));
      video.currentTime = next;
      posRef.current = next;
      lastReport.current = next;
      setCurrent(next);
      poke();
    },
    [poke]
  );

  const skip = useCallback((delta: number) => seekTo(posRef.current + delta), [seekTo]);

  const gestures = useGestures({
    // На паузе 2× бессмысленно, а случайное зажатие не должно ничего менять.
    onHoldStart: () => {
      const video = videoRef.current;
      if (video && !video.paused) video.playbackRate = HOLD_RATE;
    },
    onHoldEnd: () => {
      const video = videoRef.current;
      if (video) video.playbackRate = rate;
    },
    onDoubleTap: (side) => skip(side === "left" ? -SKIP_SEC : SKIP_SEC),
    // Одно касание: кнопки видны — спрятать (только во время игры, на паузе
    // они нужны всегда); спрятаны — показать и завести таймер.
    onTap: () => {
      const video = videoRef.current;
      if (controlsShown && video && !video.paused) setControlsShown(false);
      else poke();
    },
  });

  const dismissHint = useCallback(() => {
    setHint(false);
    markHintSeen();
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return; // ползунок сам обрабатывает стрелки
    if (e.key === " " || e.key === "k") {
      if (target.tagName === "BUTTON") return; // кнопка нажмётся сама
      e.preventDefault();
      playPause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      skip(-SKIP_SEC);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      skip(SKIP_SEC);
    } else if (e.key === "f") {
      e.preventDefault();
      void fs.toggle();
    }
  };

  const updateBuffered = () => {
    const video = videoRef.current;
    if (video && video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
  };

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    posRef.current = video.currentTime;
    setCurrent(video.currentTime);
    updateBuffered();
    if (video.duration && video.currentTime - lastReport.current >= REPORT_EVERY_SEC) report("fetch");
  };

  const busy = (hls.stalled || waiting) && !hls.error && !captureBlocked;

  return (
    <div
      ref={wrapperRef}
      className={`player${fs.active ? " is-fullscreen" : ""}${fs.active && fs.pseudo ? " is-pseudo-fullscreen" : ""}${controlsShown ? "" : " hide-controls"}${gestures.holding ? " is-holding" : ""}`}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={poke}
    >
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noremoteplayback"
        preload={preloadMode()}
        aria-label={t.videoLabel(title)}
        onContextMenu={(e) => e.preventDefault()}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
        onProgress={updateBuffered}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onPlay={() => {
          setPlaying(true);
          poke();
        }}
        onPause={() => {
          setPlaying(false);
          setWaiting(false);
          setControlsShown(true);
          report("fetch");
        }}
        onEnded={() => {
          // Браузер шлёт pause перед ended, но полагаться на это не стоит —
          // замок экрана должен отпуститься в любом случае.
          setPlaying(false);
          const video = videoRef.current;
          if (video?.duration) onProgress(Math.floor(video.duration), 100, "fetch");
        }}
      />

      {/* Слой жестов над видео, под кнопками: долгое нажатие на Android зовёт
          контекстное меню — гасим, иначе 2× прерывалось бы системным меню. */}
      <div
        className="player-gesture"
        data-testid="player-gesture"
        {...gestures.bind}
        onContextMenu={(e) => e.preventDefault()}
      />

      <Watermark text={watermark} />

      {gestures.holding && (
        <div className="player-badge" role="status">
          {HOLD_RATE}×
        </div>
      )}
      {gestures.ripple && (
        <div key={gestures.ripple.id} className={`player-ripple is-${gestures.ripple.side}`} aria-hidden="true">
          {gestures.ripple.side === "left" ? `−${SKIP_SEC}` : `+${SKIP_SEC}`}
        </div>
      )}

      {busy && (
        <div className="player-spinner" role="status" aria-label={t.buffering} data-testid="player-spinner">
          <span />
        </div>
      )}

      {!playing && !busy && !hls.error && !captureBlocked && (
        <button type="button" className="player-center" onClick={playPause} aria-label={t.playVideo}>
          <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
            <path d="M11 6v24l20-12z" fill="currentColor" />
          </svg>
        </button>
      )}

      <Controls
        t={t}
        playing={playing}
        current={current}
        duration={duration}
        buffered={buffered}
        rate={rate}
        levels={hls.levels}
        level={hls.level}
        autoLevel={hls.autoLevel}
        showQuality={showQuality && !hls.native}
        fullscreen={fs.active}
        onPlayPause={playPause}
        onSeek={seekTo}
        onSkip={skip}
        onRate={setRate}
        onLevel={hls.setLevel}
        onFullscreen={() => void fs.toggle()}
        onPoke={poke}
      />

      {hint && !hls.error && !captureBlocked && <Hint t={t} onDismiss={dismissHint} />}

      {captureBlocked && (
        <div className="player-overlay" role="alert">
          <strong>{t.captureTitle}</strong>
          <p>{t.captureText}</p>
        </div>
      )}

      {hls.error && !captureBlocked && <ErrorOverlay t={t} kind={hls.error} onRetry={hls.retry} />}
    </div>
  );
}
