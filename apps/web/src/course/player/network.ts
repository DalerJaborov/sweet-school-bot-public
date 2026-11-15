/**
 * ПОДСКАЗКА О КАЧЕСТВЕ СВЯЗИ. Network Information API есть в Chrome на
 * Android — то есть ровно там, где интернет у учениц чаще всего мобильный и
 * слабый. По нему решаем две вещи ещё до первого байта видео:
 *  • с какой дорожки стартовать (на 2g/3g или «экономии трафика» — с 480p,
 *    чтобы кадр появился сразу, а не через полминуты буферизации 1080p);
 *  • сколько качать заранее (`preload`: на wifi/4g — `auto`, иначе только
 *    `metadata`, чтобы не жечь чужой трафик до нажатия «Смотреть»).
 * Где API нет (iOS, десктоп) — считаем связь хорошей и доверяем ABR hls.js.
 */
type NetworkInformation = {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  saveData?: boolean;
};

function connection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

/** Слабая связь или включена экономия трафика. */
export function isSlowNetwork(): boolean {
  const c = connection();
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g";
}

/** Значение атрибута `preload` для <video>. */
export function preloadMode(): "auto" | "metadata" {
  return isSlowNetwork() ? "metadata" : "auto";
}

/** Высота дорожки, с которой стартуем на слабой связи. */
export const SLOW_START_HEIGHT = 480;

/**
 * ПАМЯТЬ О СКОРОСТИ КАНАЛА между уроками (15.11.2026, из аудита скорости
 * PR 21). Без неё каждый урок стартует с консервативных 500 кбит/с и первые
 * секунды играет в низком качестве, даже если связь хорошая; с ней hls.js
 * сразу берёт честную оценку прошлого просмотра, а ABR дальше правит сам.
 * Это не выбор качества «навсегда» (его намеренно не храним, см. prefs.ts) —
 * только стартовая оценка, и старше недели она не берётся.
 */
const BW_KEY = "ssb_bw";
/** Оценку старше этого не берём: связь в дороге и дома разная. */
const BW_MAX_AGE_MS = 7 * 86_400_000;
/** Разумные границы: мусор в хранилище не должен ломать выбор качества. */
const BW_MIN = 100_000;
const BW_MAX = 100_000_000;

/** Последняя измеренная скорость канала (бит/с) или null. */
export function loadBandwidth(now = Date.now()): number | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BW_KEY) ?? "null") as { bps?: unknown; at?: unknown } | null;
    if (!raw || typeof raw.bps !== "number" || typeof raw.at !== "number") return null;
    if (!Number.isFinite(raw.bps) || !Number.isFinite(raw.at)) return null;
    if (raw.at > now || now - raw.at > BW_MAX_AGE_MS) return null;
    if (raw.bps < BW_MIN || raw.bps > BW_MAX) return null;
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
    // Нет хранилища (приватный режим) — просто стартуем с консервативной оценки.
  }
}
