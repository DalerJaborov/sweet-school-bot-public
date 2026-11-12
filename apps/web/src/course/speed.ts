import type { CourseInfo, LessonView } from "./api";
import { lessonsOf } from "./api";
import { isSlowNetwork } from "./player/network";

/**
 * УСКОРЕНИЕ ПЛАТФОРМЫ — чистые помощники (рубильник `courseSpeedMode` в
 * Настройках панели; сервер отдаёт его как `view.speed`). Всё здесь работает
 * только при включённом рубильнике и ничего не знает о защите: ключи,
 * подписанные ссылки и срок офлайн-доступа проверяются как раньше.
 */

const BW_KEY = "ssb_bw";
/** Оценку канала старше этого не берём: связь в дороге и дома разная. */
const BW_MAX_AGE_MS = 7 * 86_400_000;
/** Разумные границы: мусор в хранилище не должен ломать выбор качества. */
const BW_MIN = 100_000;
const BW_MAX = 100_000_000;

/** Доля просмотра, после которой тихо качаем следующий урок в память телефона. */
export const PREFETCH_NEXT_AT_PERCENT = 80;

/** Последняя измеренная скорость канала (бит/с) — стартовая оценка для hls.js. */
export function loadBandwidth(now = Date.now()): number | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BW_KEY) ?? "null") as { bps?: unknown; at?: unknown } | null;
    if (!raw || typeof raw.bps !== "number" || typeof raw.at !== "number") return null;
    if (!Number.isFinite(raw.bps) || !Number.isFinite(raw.at) || raw.at > now || now - raw.at > BW_MAX_AGE_MS || raw.bps < BW_MIN || raw.bps > BW_MAX) return null;
    return raw.bps;
  } catch {
    return null;
  }
}

export function saveBandwidth(bps: number, now = Date.now()): void {
  if (!Number.isFinite(bps) || bps < BW_MIN || bps > BW_MAX) return;
  try {
    localStorage.setItem(BW_KEY, JSON.stringify({ bps: Math.round(bps), at: now }));
  } catch {
    // Нет хранилища — просто каждый раз стартуем с консервативной оценки.
  }
}

/**
 * Играть ли урок из памяти телефона, когда интернет ЕСТЬ. Нужны: рубильник,
 * сохранённая копия и Service Worker, который её отдаст (без него адрес
 * /offline/… ушёл бы на сервер и дал бы пустую страницу).
 */
export function playLocalFirst(o: { fast: boolean; saved: boolean; swControlled: boolean; failed: boolean; authorized: boolean }): boolean {
  return o.fast && o.saved && o.swControlled && !o.failed && o.authorized;
}

export function swControlled(): boolean {
  try {
    return Boolean(navigator.serviceWorker?.controller);
  } catch {
    return false;
  }
}

/** Можно ли без вреда качать следующий урок: не экономия трафика и не 2g/3g. */
export function mayPrefetch(requireKnownUnmetered = false): boolean {
  if (isSlowNetwork()) return false;
  if (!requireKnownUnmetered) return true;
  const connection = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection;
  return Boolean(connection && ["wifi", "ethernet"].includes(connection.type ?? "") && connection.effectiveType === "4g");
}

/** Следующий готовый урок после данного (внутри одного курса). */
export function nextLessonOf(courses: CourseInfo[], lessonId: string): LessonView | null {
  for (const course of courses) {
    const list = lessonsOf(course);
    const i = list.findIndex((l) => l.id === lessonId);
    if (i >= 0) return list.slice(i + 1).find((l) => l.ready) ?? null;
  }
  return null;
}
