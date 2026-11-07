import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type HlsType from "hls.js";
import type { PlayerErrorKind } from "./ErrorOverlay";
import { isSlowNetwork, SLOW_START_HEIGHT } from "./network";
import { nativeLevels } from "./nativeLevels";
import { loadBandwidth, saveBandwidth } from "../speed";

export type QualityLevel = { index: number; height: number };

/** Сколько раз молча повторить после фатальной сетевой ошибки, прежде чем показать оверлей. */
export const NETWORK_RETRIES = 3;
/** Пауза перед повтором: 1 с, 2 с, 4 с — связь в маршрутке пропадает на секунды, не навсегда. */
export const retryDelayMs = (attempt: number): number => 1000 * 2 ** attempt;

/**
 * ИСТОЧНИК ВИДЕО: нативный HLS (Safari, iOS — экономнее по батарее) или hls.js
 * (Chrome на Android). hls.js весит около 600 КБ и грузится отдельным куском
 * только когда реально нужен: у части учениц мобильный интернет дорогой и
 * медленный, и лишние полмегабайта на старте они бы честно заметили.
 *
 * НАСТРОЙКА ПОД СЛАБУЮ СВЯЗЬ (03.09.2026, просьба владельца «не зависает ни
 * на чём, открывается мгновенно»):
 *  • старт с дорожки по фактической скорости (`startLevel: -1`), но на 2g/3g
 *    и при «экономии трафика» — принудительно с 480p: первый кадр важнее
 *    чёткости, а ABR доберёт качество за минуту сам;
 *  • буфер вперёд 60 с (до 120 с, если память позволяет) — на мобильной связи
 *    скорость «дышит», и запас в минуту сглаживает провалы; назад держим 30 с,
 *    чтобы «−10» не качало заново;
 *  • стартовая оценка канала консервативная (500 кбит/с) — лучше секунду
 *    посмотреть в 480p, чем 20 секунд крутить спиннер, выбрав 1080p наугад;
 *  • качество не выше размера плеера (`capLevelToPlayerSize`) — 1080p на
 *    экране 360px — чистый перерасход трафика;
 *  • много попыток на фрагмент и манифест — hls.js сам переживает короткие
 *    обрывы, не доводя до фатальной ошибки.
 *
 * ОШИБКИ:
 *  • застревание буфера (`bufferStalledError`, не фатально) → `stalled` для
 *    спиннера, hls.js подтягивает сам; сбрасываем, как только пошёл кадр;
 *  • фатальная сетевая → до NETWORK_RETRIES тихих `startLoad` с нарастающей
 *    паузой, затем оверлей «Попробовать снова»; при `online` — повтор сразу;
 *  • медиа → до двух тихих `recoverMediaError`, затем оверлей;
 *  • нативный HLS → `video.load()` и возврат на ту же секунду.
 * Текущая секунда живёт в `posRef` плеера — она же переживает смену источника.
 *
 * АВТО-КАЧЕСТВО: `autoLevel` — какую дорожку ABR выбрал сейчас, чтобы в кнопке
 * писать «Авто · 720p»: человек видит, что происходит, и реже лезет
 * переключать руками.
 */
export function useHls(
  videoRef: RefObject<HTMLVideoElement>,
  src: string,
  posRef: MutableRefObject<number>,
  /** Рубильник ускорения: старт с низкого качества, память о скорости канала. */
  fast = false
): {
  native: boolean;
  levels: QualityLevel[];
  /** Ручной выбор: −1 — авто. */
  level: number;
  /** Дорожка, которую сейчас играет ABR (индекс в `levels`), −1 — ещё неизвестно. */
  autoLevel: number;
  setLevel: (index: number) => void;
  error: PlayerErrorKind | null;
  stalled: boolean;
  retry: () => void;
} {
  const nativeSources = useRef<string[]>([]);
  const nativeSeek = useRef<(() => void) | null>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const [native, setNative] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [level, setLevelState] = useState(-1);
  const [autoLevel, setAutoLevel] = useState(-1);
  const [error, setError] = useState<PlayerErrorKind | null>(null);
  const [stalled, setStalled] = useState(false);
  const mediaRecoveries = useRef(0);
  const networkRetries = useRef(0);
  const retryTimer = useRef<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    setStalled(false);
    setLevels([]);
    setLevelState(-1);
    setAutoLevel(-1);
    mediaRecoveries.current = 0;
    networkRetries.current = 0;

    nativeSources.current = [];
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNative(true);
      video.src = src;
      const abort = new AbortController();
      // Safari still adapts automatically. Reading the small master adds manual
      // choices without downloading hls.js or exposing a different access path.
      void fetch(src, { credentials: "include", signal: abort.signal })
        .then(async (response) => response.ok ? response.text() : "")
        .then((body) => {
          if (abort.signal.aborted) return;
          const parsed = nativeLevels(body, new URL(src, location.href).href);
          nativeSources.current = parsed.map((item) => item.url);
          setLevels(parsed.map((item, index) => ({ index, height: item.height })));
        }).catch(() => undefined);
      const onError = () => setError("network");
      video.addEventListener("error", onError);
      return () => {
        abort.abort();
        if (nativeSeek.current) video.removeEventListener("loadedmetadata", nativeSeek.current);
        nativeSeek.current = null;
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
      };
    }

    setNative(false);
    let disposed = false;
    let startOnPlay: (() => void) | undefined;
    // Authenticated manifests are no-store: a warm-up fetch only duplicates traffic.
    void import("hls.js").then(({ default: Hls }) => {
      if (disposed) return;
      if (!Hls.isSupported()) {
        setError("unsupported");
        return;
      }
      const slow = isSlowNetwork();
      const knownBw = fast && !slow ? loadBandwidth() : null;
      const hls = new Hls({
        // Ключ и сегменты идут с нашей же сессией: без куки сервер не отдаст ключ.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
        enableWorker: true, // разбор сегментов в воркере — интерфейс не дёргается
        lowLatencyMode: false, // это записи, не эфир: латентность не важна, важна плавность
        // Ускорение: первый сегмент всегда с самой лёгкой дорожки (кадр
        // важнее чёткости), дальше ABR сам поднимает качество; префетч
        // первого фрагмента экономит круг до сервера.
        startLevel: fast ? 0 : -1,
        autoStartLoad: !slow,
        startFragPrefetch: fast,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        abrEwmaDefaultEstimate: knownBw ?? 500_000,
        capLevelToPlayerSize: true,
        fragLoadingMaxRetry: 8,
        levelLoadingMaxRetry: 8,
        manifestLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      if (slow) {
        startOnPlay = () => hls.startLoad(posRef.current);
        video.addEventListener("play", startOnPlay);
        if (!video.paused) startOnPlay();
      }

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const parsed = hls.levels.map((l, index) => ({ index, height: l.width ? Math.min(l.width, l.height) : l.height }));
        setLevels(parsed);
        // Слабая связь: первый фрагмент — с 480p (или ближайшей снизу), потом авто.
        if (!fast && slow && parsed.length > 1) {
          const fit = parsed.filter((l) => l.height <= SLOW_START_HEIGHT).sort((a, b) => b.height - a.height)[0];
          if (fit) hls.startLevel = fit.index;
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setAutoLevel(data.level));
      let bufferedFrags = 0;
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        // Запоминаем скорость канала раз в несколько сегментов: следующий
        // урок стартует с честной оценкой, а не с консервативных 500 кбит/с.
        if (fast && ++bufferedFrags % 4 === 0) saveBandwidth(hls.bandwidthEstimate);
        setStalled(false);
        networkRetries.current = 0; // связь ожила — счётчик повторов с нуля
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) setStalled(true);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (networkRetries.current < NETWORK_RETRIES) {
            const attempt = networkRetries.current;
            networkRetries.current += 1;
            setStalled(true);
            if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
            retryTimer.current = window.setTimeout(() => {
              retryTimer.current = null;
              if (!disposed) hls.startLoad(posRef.current);
            }, retryDelayMs(attempt));
          } else {
            if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
            retryTimer.current = null;
            setStalled(false);
            setError("network");
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries.current < 2) {
          mediaRecoveries.current += 1;
          hls.recoverMediaError();
        } else {
          setStalled(false);
          setError("media");
        }
      });
    });

    return () => {
      disposed = true;
      if (startOnPlay) video.removeEventListener("play", startOnPlay);
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [videoRef, src, posRef, fast]);

  const retry = useCallback(() => {
    setError(null);
    setStalled(false);
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const video = videoRef.current;
    const hls = hlsRef.current;
    const pos = posRef.current;
    if (hls) {
      mediaRecoveries.current = 0;
      networkRetries.current = 0;
      hls.startLoad(pos);
    } else if (video) {
      video.load();
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = pos;
        },
        { once: true }
      );
    }
    void video?.play().catch(() => undefined);
  }, [videoRef, posRef]);

  // Связь вернулась — повторяем сами, не дожидаясь нажатия.
  useEffect(() => {
    if (error !== "network" && !stalled) return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [error, stalled, retry]);

  const setLevel = useCallback((index: number) => {
    if (native) {
      const video = videoRef.current;
      if (!video || !Number.isInteger(index) || index < -1 || index >= nativeSources.current.length) return;
      const position = video.currentTime;
      const playing = !video.paused;
      const rate = video.playbackRate;
      if (nativeSeek.current) video.removeEventListener("loadedmetadata", nativeSeek.current);
      const restore = () => {
        video.currentTime = position;
        video.playbackRate = rate;
        if (playing) void video.play().catch(() => undefined);
        nativeSeek.current = null;
      };
      nativeSeek.current = restore;
      video.addEventListener("loadedmetadata", restore, { once: true });
      video.src = index === -1 ? src : nativeSources.current[index];
      video.load();
      setLevelState(index);
      setError(null);
      return;
    }
    const hls = hlsRef.current;
    if (!hls || !Number.isInteger(index) || index < -1 || index >= hls.levels.length) return;
    hls.currentLevel = index;
    setLevelState(index);
  }, [native, videoRef, src]);

  return { native, levels, level, autoLevel, setLevel, error, stalled, retry };
}
