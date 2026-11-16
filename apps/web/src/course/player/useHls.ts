import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type HlsType from "hls.js";
import type { PlayerErrorKind } from "./ErrorOverlay";
import { isSlowNetwork, loadBandwidth, saveBandwidth, SLOW_START_HEIGHT } from "./network";
import { isSameOrigin } from "../sameOrigin";

export type QualityLevel = { index: number; height: number };

/** Сколько раз молча повторить после фатальной сетевой ошибки, прежде чем показать оверлей. */
export const NETWORK_RETRIES = 3;
/** Пауза перед повтором: 1 с, 2 с, 4 с — связь в маршрутке пропадает на секунды, не навсегда. */
export const retryDelayMs = (attempt: number): number => 1000 * 2 ** attempt;
/** Раз во сколько загруженных сегментов запоминать скорость канала. */
export const SAVE_BW_EVERY_FRAGS = 4;
/** Стартовая оценка канала, если прошлой нет: лучше секунду в 480p, чем спиннер. */
export const DEFAULT_BW_ESTIMATE = 500_000;

/**
 * «Качество» дорожки — КОРОТКАЯ сторона кадра, как на сервере (qualitySide):
 * уроки вертикальные 720×1280, и по высоте меню показало бы «1280p».
 */
export const levelQuality = (l: { width?: number; height: number }): number =>
  l.width && l.width > 0 ? Math.min(l.width, l.height) : l.height;

/**
 * ИСТОЧНИК ВИДЕО: нативный HLS (Safari, iOS — экономнее по батарее) или hls.js
 * (Chrome на Android). hls.js — облегчённая сборка `hls.js/light` (AES-128 в ней есть:
 * проверено по исходникам и живым прогоном; 365 КБ вместо 584) — грузится отдельным куском
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
 *  • стартовая оценка канала — скорость с прошлого урока (network.ts,
 *    не старше недели), а если её нет — консервативные 500 кбит/с: лучше
 *    секунду посмотреть в 480p, чем 20 секунд крутить спиннер;
 *  • качество не выше размера плеера (`capLevelToPlayerSize`) — 1080p на
 *    экране 360px — чистый перерасход трафика;
 *  • много попыток на фрагмент и манифест — hls.js сам переживает короткие
 *    обрывы, не доводя до фатальной ошибки.
 *
 * ОШИБКИ:
 *  • застревание буфера (`bufferStalledError`, не фатально) → `stalled` для
 *    спиннера, hls.js подтягивает сам; сбрасываем, как только пошёл кадр;
 *  • фатальная сетевая → до NETWORK_RETRIES тихих `startLoad` с нарастающей
 *    паузой, затем оверлей «Попробовать снова»; при `online` — повтор сразу
 *    (и во время тихих повторов тоже: ждать 4 с, когда сеть уже есть, незачем);
 *  • медиа → до двух тихих `recoverMediaError`, затем оверлей;
 *  • нативный HLS → `video.load()` и возврат на ту же секунду.
 * Текущая секунда живёт в `posRef` плеера — она же переживает смену источника.
 *
 * АВТО-КАЧЕСТВО: `autoLevel` — какую дорожку ABR выбрал сейчас, чтобы в кнопке
 * писать «Авто · 720p»: человек видит, что происходит, и реже лезет
 * переключать руками.
 */
/**
 * Перечитать манифест и продолжить с той же секунды. Нужен там, где ссылки
 * на сегменты могли истечь: hls.js читает плейлист записи один раз и сам его
 * не обновляет, а `startLoad` повторил бы те же мёртвые ссылки.
 */
export function reloadSource(
  hls: Pick<HlsType, "config" | "loadSource">,
  src: string,
  position: number,
  video?: HTMLVideoElement | null
): void {
  // Замер 16.11.2026 в Chromium (hls.js 1.6): после loadSource секунда
  // сохраняется, но видео встаёт на паузу. Играло — продолжаем само.
  const wasPlaying = Boolean(video && !video.paused);
  hls.config.startPosition = position > 0 ? position : -1;
  hls.loadSource(src);
  if (wasPlaying) void video?.play().catch(() => undefined);
}

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
  const nativeRef = useRef(false);
  /** Растёт на «Попробовать снова», когда hls.js не загрузился: перезапуск эффекта. */
  const [generation, setGeneration] = useState(0);

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

    setNative(false);
    nativeRef.current = false;
    let disposed = false;
    let nativeCleanup: (() => void) | null = null;
    // Прогрева манифеста отдельным fetch больше нет (16.11.2026): сервер
    // отдаёт его с `no-store`, в HTTP-кэш он не ложился, и на слабой связи
    // это был просто второй запрос того же манифеста.
    //
    // Кусок hls.js грузится отдельно. Не загрузился (обрыв связи, или сайт
    // обновили, пока страница была открыта, и старого куска уже нет) —
    // раньше спиннер крутился вечно. Теперь — «Попробовать снова».
    void import("hls.js/light").catch(() => {
      if (!disposed) {
        setStalled(false);
        setError("network");
      }
      return null;
    }).then((mod) => {
      if (!mod) return;
      const Hls = mod.default;
      if (disposed) return;
      if (!Hls.isSupported()) {
        // Старый iPhone без MSE: играем родным HLS (без выбора качества).
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          setNative(true);
          nativeRef.current = true;
          video.src = src;
          const onError = () => setError("network");
          video.addEventListener("error", onError);
          nativeCleanup = () => {
            video.removeEventListener("error", onError);
            video.removeAttribute("src");
            video.load();
          };
        } else setError("unsupported");
        return;
      }
      const slow = isSlowNetwork();
      // На слабой связи стартуем с 480p принудительно — прошлая оценка там не нужна.
      const knownBw = slow ? null : loadBandwidth();
      const hls = new Hls({
        // Манифест и ключ — наш сервер, ему нужна сессия. Сегменты — подписанные
        // ссылки на хранилище: с куками туда браузер не пустит (CORS без
        // Allow-Credentials), и урок крутил бы спиннер вечно. См. sameOrigin.ts.
        xhrSetup: (xhr, url) => {
          xhr.withCredentials = isSameOrigin(url);
        },
        enableWorker: true, // разбор сегментов в воркере — интерфейс не дёргается
        lowLatencyMode: false, // это записи, не эфир: латентность не важна, важна плавность
        startLevel: -1,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        abrEwmaDefaultEstimate: knownBw ?? DEFAULT_BW_ESTIMATE,
        capLevelToPlayerSize: true,
        fragLoadingMaxRetry: 8,
        levelLoadingMaxRetry: 8,
        manifestLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const parsed = hls.levels.map((l, index) => ({ index, height: levelQuality(l) }));
        setLevels(parsed);
        // Слабая связь: первый фрагмент — с 480p (или ближайшей снизу), потом авто.
        if (slow && parsed.length > 1) {
          const fit = parsed.filter((l) => l.height <= SLOW_START_HEIGHT).sort((a, b) => b.height - a.height)[0];
          if (fit) hls.startLevel = fit.index;
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setAutoLevel(data.level));
      let bufferedFrags = 0;
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        // Следующий урок стартует с честной оценкой канала, а не с 500 кбит/с.
        if (++bufferedFrags % SAVE_BW_EVERY_FRAGS === 0) saveBandwidth(hls.bandwidthEstimate);
        setStalled(false);
        networkRetries.current = 0; // связь ожила — счётчик повторов с нуля
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) setStalled(true);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.response?.code === 409) {
          // Сервер: курс играет на другом телефоне. Повторы бессмысленны.
          setStalled(false);
          setError("elsewhere");
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (networkRetries.current < NETWORK_RETRIES) {
            const attempt = networkRetries.current;
            networkRetries.current += 1;
            setStalled(true);
            if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
            // 403 от хранилища — истёкшая подпись сегмента: ждать незачем,
            // свежие ссылки даст только перечитанный манифест.
            const expired = data.response?.code === 403;
            retryTimer.current = window.setTimeout(
              () => {
                retryTimer.current = null;
                if (!disposed) reloadSource(hls, src, posRef.current, video);
              },
              expired ? 0 : retryDelayMs(attempt)
            );
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
      nativeCleanup?.();
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [videoRef, src, posRef, generation]);

  const retry = useCallback(() => {
    setError(null);
    setStalled(false);
    // Отложенный тихий повтор больше не нужен — повторяем сейчас.
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
      // Перечитываем манифест, а не только startLoad: после долгой паузы
      // ссылки на сегменты могли истечь, и старые повторять бесполезно.
      reloadSource(hls, src, pos, video);
    } else if (!nativeRef.current) {
      // hls.js так и не загрузился — запускаем всё с начала.
      setGeneration((g) => g + 1);
      return;
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
  }, [videoRef, posRef, src]);

  // Связь вернулась — повторяем сами, не дожидаясь нажатия.
  // Срабатывает и во время тихих повторов (`stalled`): сеть уже есть — не ждём таймер.
  useEffect(() => {
    if (error !== "network" && !stalled) return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [error, stalled, retry]);

  const setLevel = useCallback((index: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = index;
    setLevelState(index);
  }, []);

  return { native, levels, level, autoLevel, setLevel, error, stalled, retry };
}
