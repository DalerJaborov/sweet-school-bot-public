import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type HlsType from "hls.js";
import type { PlayerErrorKind } from "./ErrorOverlay";
import { isSlowNetwork, SLOW_START_HEIGHT } from "./network";

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
  posRef: MutableRefObject<number>
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

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNative(true);
      video.src = src;
      const onError = () => setError("network");
      video.addEventListener("error", onError);
      return () => {
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
      };
    }

    setNative(false);
    let disposed = false;
    // Манифест греем сразу, параллельно с загрузкой куска hls.js (~190 КБ
    // сжатых): иначе на первом открытии они шли бы друг за другом, и на 3g
    // это лишняя секунда до первого кадра. Ответ ляжет в HTTP-кэш, hls.js
    // возьмёт его оттуда. Ошибка здесь не важна — hls.js запросит сам.
    if (typeof fetch === "function") void fetch(src, { credentials: "include" }).catch(() => undefined);
    void import("hls.js").then(({ default: Hls }) => {
      if (disposed) return;
      if (!Hls.isSupported()) {
        setError("unsupported");
        return;
      }
      const slow = isSlowNetwork();
      const hls = new Hls({
        // Ключ и сегменты идут с нашей же сессией: без куки сервер не отдаст ключ.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
        enableWorker: true, // разбор сегментов в воркере — интерфейс не дёргается
        lowLatencyMode: false, // это записи, не эфир: латентность не важна, важна плавность
        startLevel: -1,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        abrEwmaDefaultEstimate: 500_000,
        capLevelToPlayerSize: true,
        fragLoadingMaxRetry: 8,
        levelLoadingMaxRetry: 8,
        manifestLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const parsed = hls.levels.map((l, index) => ({ index, height: l.height }));
        setLevels(parsed);
        // Слабая связь: первый фрагмент — с 480p (или ближайшей снизу), потом авто.
        if (slow && parsed.length > 1) {
          const fit = parsed.filter((l) => l.height <= SLOW_START_HEIGHT).sort((a, b) => b.height - a.height)[0];
          if (fit) hls.startLevel = fit.index;
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setAutoLevel(data.level));
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
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
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [videoRef, src, posRef]);

  const retry = useCallback(() => {
    setError(null);
    setStalled(false);
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
    if (error !== "network") return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [error, retry]);

  const setLevel = useCallback((index: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = index;
    setLevelState(index);
  }, []);

  return { native, levels, level, autoLevel, setLevel, error, stalled, retry };
}
