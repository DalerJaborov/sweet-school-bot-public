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
