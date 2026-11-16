import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { environment } from "../install/detect";

type OrientationLock = ScreenOrientation & {
  lock?: (orientation: "landscape" | "portrait" | "any") => Promise<void>;
  unlock?: () => void;
};

/**
 * Полный экран ОБЁРТКИ, а не <video>: так поверх видео остаются водяной знак
 * и наши кнопки. При входе — поворот в альбомную (телефон в держателе на
 * кухне часто лежит боком, и крутить его руками в муке неудобно; для вертикального
 * видео поворота нет). На iOS
 * полноэкран элемента запрещён — остаётся системный `webkitEnterFullscreen`
 * у самого видео, но он убирает именной водяной знак.
 *
 * На iOS, включая обычный Safari, «весь экран» делаем сами —
 * обёртка растягивается на окно (класс is-pseudo-fullscreen),
 * а водяной знак и наши кнопки остаются на месте. Системный плеер тут не
 * зовём: он прячет знак, а ради чего тогда защита.
 */
export function useFullscreen(wrapperRef: RefObject<HTMLElement>, videoRef: RefObject<HTMLVideoElement>) {
  const [active, setActive] = useState(false);
  const pseudo = useMemo(() => {
    const env = environment();
    return env.platform === "ios";
  }, []);

  useEffect(() => {
    const onChange = () => {
      const on = Boolean(document.fullscreenElement);
      setActive(on);
      if (!on) {
        try {
          (screen.orientation as OrientationLock | undefined)?.unlock?.();
        } catch {
          // Не везде поддерживается — ничего страшного.
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(async () => {
    if (pseudo) {
      setActive((a) => !a);
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    const wrapper = wrapperRef.current;
    if (wrapper && typeof wrapper.requestFullscreen === "function") {
      try {
        await wrapper.requestFullscreen({ navigationUI: "hide" });
      } catch {
        return;
      }
      try {
        // Вертикальное видео (все уроки школы, 720×1280) в альбомную НЕ крутим:
        // оно стало бы узкой полоской посреди чёрного экрана и вдвое мельче,
        // чем в портретном полном экране. Альбомное — крутим, как раньше.
        const v = videoRef.current;
        const portraitVideo = Boolean(v && v.videoHeight > v.videoWidth);
        if (!portraitVideo) await (screen.orientation as OrientationLock | undefined)?.lock?.("landscape");
      } catch {
        // Настольный браузер или запрет — просто остаёмся как есть.
      }
      return;
    }
  }, [pseudo, wrapperRef, videoRef]);

  return { active, pseudo, toggle };
}
