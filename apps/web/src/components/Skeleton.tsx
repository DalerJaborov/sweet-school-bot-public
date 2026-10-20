/**
 * СКЕЛЕТОНЫ С SHIMMER («Утро Ширин» §17) вместо «Считаю…» и «Загрузка…».
 *
 * Форма-заглушка повторяет то, что появится: плитки бенто, карточки очереди,
 * строки списка. Глаз заранее знает, куда смотреть, и контент не «прыгает».
 * Один aria-busy контейнер на весь блок — читалке достаточно знать, что
 * раздел ещё грузится; каждый серый прямоугольник объявлять незачем.
 * prefers-reduced-motion гасит мерцание (styles.css).
 */
export function Skeleton({ height = 82, width, radius, className = "" }: { height?: number | string; width?: number | string; radius?: number; className?: string }) {
  return <div className={`skeleton ${className}`.trim()} style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}

/** Четыре плитки бенто, как на главной: широкая геройская + три обычных. */
export function SkeletonTiles({ hero = true, count = 4 }: { hero?: boolean; count?: number }) {
  return (
    <div className="bento" aria-busy="true" aria-label="Загружаю цифры" data-testid="skeleton-tiles">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={hero && i === 0 ? "skeleton-hero" : "skeleton-tile"} height={hero && i === 0 ? 140 : 96} />
      ))}
    </div>
  );
}

/** Стопка карточек очереди/списка. */
export function SkeletonList({ rows = 3, height = 82 }: { rows?: number; height?: number }) {
  return (
    <div className="queue" aria-busy="true" aria-label="Загружаю список" data-testid="skeleton-list">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  );
}
