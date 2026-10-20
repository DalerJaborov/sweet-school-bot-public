/**
 * СПАРКЛАЙН НА 14 ДНЕЙ — один inline-SVG, без библиотеки графиков.
 *
 * Показывает форму недели, а не точные числа: точные — в «Деньгах». Поэтому
 * нет осей и подписей, только линия, мягкая заливка под ней и точка на
 * последнем дне. Цвета — токены, чтобы совпадать с плитками рядом.
 */
import { money } from "../format";

export function Sparkline({
  points,
  width = 320,
  height = 56,
  label,
}: {
  points: { day: string; money: number }[];
  width?: number;
  height?: number;
  label: string;
}) {
  const pad = 6;
  const max = Math.max(1, ...points.map((p) => p.money));
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (p.money / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = xy.length > 0 ? `${line} L${xy[xy.length - 1][0].toFixed(1)} ${height - pad} L${xy[0][0].toFixed(1)} ${height - pad} Z` : "";
  const last = xy[xy.length - 1];
  const title = points.map((p) => `${p.day}: ${money(p.money)}`).join(", ");

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${title}`}
    >
      <path d={area} fill="var(--accent)" opacity="0.12" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--accent)" stroke="var(--card)" strokeWidth="2" />}
    </svg>
  );
}
