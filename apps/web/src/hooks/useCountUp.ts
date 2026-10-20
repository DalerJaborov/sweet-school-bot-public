import { useEffect, useRef, useState } from "react";

/**
 * ЧИСЛО «ПЕРЕСЧИТЫВАЕТСЯ» («Утро Ширин» §17): когда значение плитки
 * меняется (обновили день, подтвердили чек), цифра за 400 мс добегает от
 * старого значения к новому, а не прыгает. При первом показе — сразу
 * итог: анимация от нуля при каждом открытии панели раздражала бы.
 *
 * prefers-reduced-motion → мгновенно, без requestAnimationFrame вовсе.
 */
export const COUNT_UP_MS = 400;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useCountUp(value: number, duration = COUNT_UP_MS): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      from.current = value;
      return;
    }
    if (value === from.current) return;
    if (prefersReducedMotion() || duration <= 0 || typeof requestAnimationFrame !== "function") {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const begin = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(begin + (value - begin) * eased);
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, duration]);

  return shown;
}
