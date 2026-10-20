import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * ЖЕСТЫ КАК В МОБИЛЬНОМ YOUTUBE — ученицы знают их наизусть, объяснять нечего:
 *  • зажать палец где угодно на видео (≥ 400 мс) → 2×, отпустить → прежняя
 *    скорость;
 *  • двойное касание по левой/правой трети → −10/+10 секунд;
 *  • одиночное касание → показать/спрятать кнопки.
 *
 * ПОЧЕМУ pointer events, а не touch/click: один код для пальца, мыши и стилуса,
 * и нет 300-мс задержки click на старых Android. Одиночное касание срабатывает
 * с задержкой DOUBLE_TAP_MS — иначе первое касание двойного успевало бы
 * спрятать кнопки, и экран мигал бы.
 *
 * Свайпы намеренно не делаем: на кухне телефон трогают мокрым пальцем, и
 * случайная перемотка на пять минут бесит сильнее, чем отсутствие жеста.
 */
export const HOLD_MS = 400;
export const DOUBLE_TAP_MS = 300;
/** Палец «уехал» дальше — это уже не касание, а прокрутка страницы. */
const MOVE_TOLERANCE_PX = 12;
/** Сколько держать всплеск «±10» на экране. */
const RIPPLE_MS = 600;

export type SeekRipple = { side: "left" | "right"; id: number };

type GestureHandlers = {
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onDoubleTap: (side: "left" | "right") => void;
  onTap: () => void;
};

export function useGestures(h: GestureHandlers) {
  const [holding, setHolding] = useState(false);
  const [ripple, setRipple] = useState<SeekRipple | null>(null);

  const handlers = useRef(h);
  handlers.current = h;

  const holdTimer = useRef<number | null>(null);
  const tapTimer = useRef<number | null>(null);
  const rippleTimer = useRef<number | null>(null);
  const holdingRef = useRef(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const lastTap = useRef<{ at: number; x: number } | null>(null);

  const clear = (ref: { current: number | null }) => {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  };

  const endHold = useCallback(() => {
    clear(holdTimer);
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    handlers.current.onHoldEnd();
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    // Только основная кнопка: правая мышь — это контекстное меню, его гасим отдельно.
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    moved.current = false;
    clear(holdTimer);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      if (moved.current) return;
      holdingRef.current = true;
      setHolding(true);
      handlers.current.onHoldStart();
    }, HOLD_MS);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId || moved.current) return;
    if (Math.abs(e.clientX - s.x) > MOVE_TOLERANCE_PX || Math.abs(e.clientY - s.y) > MOVE_TOLERANCE_PX) {
      moved.current = true;
      clear(holdTimer);
    }
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      start.current = null;
      if (!s || s.id !== e.pointerId) return;
      const wasHolding = holdingRef.current;
      endHold();
      if (wasHolding || moved.current) return; // ускорение и прокрутка — не касание

      const now = Date.now();
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const prev = lastTap.current;
      if (prev && now - prev.at < DOUBLE_TAP_MS) {
        lastTap.current = null;
        clear(tapTimer);
        // Средняя треть — как в YouTube, там двойное касание ничего не делает:
        // иначе «пауза-пауза» по центру превращалась бы в перемотку.
        const third = rect.width > 0 ? x / rect.width : 0.5;
        if (third < 1 / 3 || third > 2 / 3) {
          const side = third < 1 / 3 ? "left" : "right";
          handlers.current.onDoubleTap(side);
          clear(rippleTimer);
          setRipple({ side, id: now });
          rippleTimer.current = window.setTimeout(() => setRipple(null), RIPPLE_MS);
        }
        return;
      }
      lastTap.current = { at: now, x };
      clear(tapTimer);
      tapTimer.current = window.setTimeout(() => {
        tapTimer.current = null;
        lastTap.current = null;
        handlers.current.onTap();
      }, DOUBLE_TAP_MS);
    },
    [endHold]
  );

  // Палец ушёл за край экрана или система перехватила жест — снимаем 2×,
  // иначе видео так и бежало бы вдвое быстрее без пальца на экране.
  const onPointerCancel = useCallback(() => {
    start.current = null;
    endHold();
  }, [endHold]);

  useEffect(
    () => () => {
      clear(holdTimer);
      clear(tapTimer);
      clear(rippleTimer);
    },
    []
  );

  return {
    holding,
    ripple,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave: onPointerCancel,
    },
  };
}
