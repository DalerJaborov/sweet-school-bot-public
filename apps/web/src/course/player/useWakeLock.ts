import { useEffect, useRef, type RefObject } from "react";

/**
 * ЭКРАН НЕ ГАСНЕТ, ПОКА ИДЁТ УРОК (Screen Wake Lock, 05.09.2026).
 *
 * Главный сценарий — «повторяю на своей кухне»: руки в тесте, телефон стоит
 * у плиты, и на дешёвом Android экран гаснет через 30 секунд. Ученица либо
 * тыкает экран грязными руками, либо теряет момент. Видео само по себе не
 * везде держит экран — на iOS Safari и в WebView это не гарантировано.
 *
 * Правила: просим блокировку на play, отпускаем на pause/ended и когда
 * вкладку свернули (система сама снимает замок в фоне, но лучше явно),
 * просим снова, когда вернулись и видео всё ещё играет. Нет API (старый
 * браузер, iOS до 16.4) — тихо ничего не делаем; отказ (низкий заряд,
 * настройки) — тоже не ошибка. Здесь ничего не должно бросать.
 */
type WakeLockApi = { request(type: "screen"): Promise<WakeLockSentinel> };

function wakeLockApi(): WakeLockApi | null {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return null;
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  return api && typeof api.request === "function" ? api : null;
}

export function useWakeLock(videoRef: RefObject<HTMLVideoElement>, playing: boolean): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    const api = wakeLockApi();
    if (!api) return;
    let cancelled = false;

    const release = () => {
      const current = sentinel.current;
      sentinel.current = null;
      if (current) void current.release().catch(() => undefined);
    };

    const request = async () => {
      if (sentinel.current) return;
      try {
        const lock = await api.request("screen");
        if (cancelled) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel.current = lock;
        // Система сняла замок сама (свернули, села батарея) — забываем его,
        // иначе следующий play решит, что замок ещё держится.
        lock.addEventListener?.("release", () => {
          if (sentinel.current === lock) sentinel.current = null;
        });
      } catch {
        // Отказ — штатный исход, без блокировки урок всё равно идёт.
      }
    };

    if (playing) void request();
    else release();

    const onVisibility = () => {
      if (document.hidden) release();
      else if (playing && videoRef.current && !videoRef.current.paused) void request();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [playing, videoRef]);
}
