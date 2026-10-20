/**
 * Декоративные рисунки: венчик с чашей на заставке, кекс — для пустых
 * состояний, облачко — для чата. Чистый SVG в токенах темы, без картинок:
 * тема меняется, рисунок перекрашивается сам. От читалок скрыты.
 */
export function Illustration({ kind, size = 96 }: { kind: "splash" | "empty" | "chat"; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 96 96",
    "aria-hidden": true as const,
    focusable: "false" as const,
  };
  if (kind === "chat") {
    return (
      <svg {...common} className="illus">
        <path
          d="M20 22h56a8 8 0 0 1 8 8v30a8 8 0 0 1-8 8H44l-16 12v-12h-8a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8z"
          className="illus-fill"
        />
        <circle cx="36" cy="45" r="4" className="illus-accent" />
        <circle cx="48" cy="45" r="4" className="illus-accent" />
        <circle cx="60" cy="45" r="4" className="illus-accent" />
      </svg>
    );
  }
  if (kind === "empty") {
    return (
      <svg {...common} className="illus">
        <path d="M26 44h44l-5 34a6 6 0 0 1-6 5H37a6 6 0 0 1-6-5z" className="illus-fill" />
        <path d="M22 40c0-12 10-18 26-18s26 6 26 18c0 5-4 8-9 8H31c-5 0-9-3-9-8z" className="illus-accent" />
        <circle cx="48" cy="18" r="5" className="illus-accent" />
      </svg>
    );
  }
  return (
    <svg {...common} className="illus">
      <path d="M18 50h60l-6 26a8 8 0 0 1-8 6H32a8 8 0 0 1-8-6z" className="illus-fill" />
      <path d="M58 14 42 48" className="illus-stroke" strokeWidth="5" strokeLinecap="round" fill="none" />
      <path d="M60 12c8 0 12 6 10 14s-10 12-18 10c-6-2-8-8-6-14s8-10 14-10z" className="illus-accent" />
    </svg>
  );
}
