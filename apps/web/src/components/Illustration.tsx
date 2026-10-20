/**
 * СЦЕНЫ ДЛЯ ПУСТЫХ СОСТОЯНИЙ («Утро Ширин» §16, волна 3A).
 *
 * Шесть плоских иллюстраций в палитре утверждённого портрета Ширин
 * (public/img/shirin.webp): крем, пудрово-розовый, малина, золото. Всё —
 * inline-SVG на трёх токенах палитры плюс currentColor для линий (толщина
 * 1.8 — как у иконок навигации в Brand.tsx, чтобы шапка и пустой экран
 * рисовались одной рукой). Внешних файлов нет: сцена весит меньше 3 КБ и
 * не ждёт сети — именно тогда, когда сеть и отвалилась (Offline).
 *
 * Все сцены декоративные (aria-hidden): смысл несёт текст рядом (EmptyState).
 */
export type Scene = "AllDone" | "QuietMorning" | "Offline" | "Importing" | "CourseReady" | "FirstCertificate";

const LINE = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** Три токена палитры: крем, пудра, малина. Золото — только у сертификата. */
const CREAM = "var(--illo-cream)";
const PINK = "var(--illo-pink)";
const BERRY = "var(--illo-berry)";
const GOLD = "var(--illo-gold)";

/** Пустой лоток «входящих» с чашкой чая — всё разобрано, можно выдохнуть. */
function AllDone() {
  return (
    <>
      <ellipse cx="60" cy="88" rx="44" ry="6" fill={CREAM} />
      <path d="M22 44h76l-6 34H28Z" fill={PINK} />
      <path d="M22 44h76l-6 34H28Z" {...LINE} />
      <path d="M22 44 33 26h54l11 18" {...LINE} />
      <path d="M40 44v6h40v-6" {...LINE} />
      <circle cx="94" cy="26" r="13" fill={BERRY} />
      <path d="m88 26 4 4 8-8" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 22c0-4 3-6 3-9M40 20c0-4 3-6 3-9" {...LINE} opacity="0.5" />
    </>
  );
}

/** Солнце над горизонтом и чашка — тихое утро, продаж ещё нет. */
function QuietMorning() {
  return (
    <>
      <circle cx="60" cy="52" r="22" fill={PINK} />
      <path d="M60 18v-8M84 28l6-6M36 28l-6-6M92 52h8M20 52h8" {...LINE} />
      <path d="M8 66h104" {...LINE} />
      <path d="M8 66c14-8 30-8 44 0s30 8 52 0" fill={CREAM} />
      <path d="M40 74h30l-3 16H43Z" fill="#fff" />
      <path d="M40 74h30l-3 16H43Z" {...LINE} />
      <path d="M70 78c6 0 6 8 0 8" {...LINE} />
      <path d="M50 72c0-3 3-4 3-7M58 72c0-3 3-4 3-7" {...LINE} opacity="0.5" />
      <circle cx="94" cy="40" r="2.5" fill={BERRY} />
    </>
  );
}

/** Облако с оборванной ниткой к телефону — сеть не отвечает. */
function Offline() {
  return (
    <>
      <path d="M34 44a14 14 0 0 1 27-6 12 12 0 0 1 22 6h3a9 9 0 0 1 0 18H36a9 9 0 0 1-2-18Z" fill={PINK} />
      <path d="M34 44a14 14 0 0 1 27-6 12 12 0 0 1 22 6h3a9 9 0 0 1 0 18H36a9 9 0 0 1-2-18Z" {...LINE} />
      <path d="M60 62v8M60 78v4" {...LINE} strokeDasharray="3 4" />
      <rect x="48" y="84" width="24" height="12" rx="4" fill={CREAM} />
      <rect x="48" y="84" width="24" height="12" rx="4" {...LINE} />
      <circle cx="90" cy="72" r="9" fill={BERRY} />
      <path d="M90 67v6M90 77v.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M18 30c2-3 5-3 7 0M96 24c2-3 5-3 7 0" {...LINE} opacity="0.4" />
    </>
  );
}

/** Папка, из которой стрелка уходит в облако — импорт идёт. */
function Importing() {
  return (
    <>
      <path d="M18 56v30a4 4 0 0 0 4 4h44a4 4 0 0 0 4-4V62a4 4 0 0 0-4-4H44l-6-6H22a4 4 0 0 0-4 4Z" fill={CREAM} />
      <path d="M18 56v30a4 4 0 0 0 4 4h44a4 4 0 0 0 4-4V62a4 4 0 0 0-4-4H44l-6-6H22a4 4 0 0 0-4 4Z" {...LINE} />
      <path d="M78 30a12 12 0 0 1 23-4 10 10 0 0 1 8 18H82a8 8 0 0 1-4-14Z" fill={PINK} />
      <path d="M78 30a12 12 0 0 1 23-4 10 10 0 0 1 8 18H82a8 8 0 0 1-4-14Z" {...LINE} />
      <path d="M44 74V48M36 56l8-8 8 8" stroke={BERRY} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="74" cy="60" r="2.2" fill={BERRY} />
      <circle cx="82" cy="54" r="2.2" fill={BERRY} opacity="0.6" />
      <circle cx="90" cy="48" r="2.2" fill={BERRY} opacity="0.3" />
    </>
  );
}

/** Карточка урока с кнопкой «играть» и конфетти — курс готов. */
function CourseReady() {
  return (
    <>
      <rect x="22" y="26" width="76" height="52" rx="8" fill={PINK} />
      <rect x="22" y="26" width="76" height="52" rx="8" {...LINE} />
      <circle cx="60" cy="52" r="13" fill={BERRY} />
      <path d="m56 45 12 7-12 7Z" fill="#fff" />
      <path d="M32 88h56" {...LINE} />
      <rect x="12" y="12" width="6" height="6" rx="1.5" fill={BERRY} transform="rotate(18 15 15)" />
      <rect x="102" y="16" width="5" height="5" rx="1.5" fill={GOLD} transform="rotate(-20 104 18)" />
      <circle cx="104" cy="60" r="3" fill={CREAM} stroke={BERRY} strokeWidth="1.5" />
      <circle cx="14" cy="50" r="2.5" fill={GOLD} />
    </>
  );
}

/** Свёрнутый диплом с золотой печатью — первый сертификат. */
function FirstCertificate() {
  return (
    <>
      <rect x="26" y="20" width="68" height="60" rx="6" fill="#fff" />
      <rect x="26" y="20" width="68" height="60" rx="6" {...LINE} />
      <rect x="34" y="28" width="52" height="44" rx="3" fill={CREAM} />
      <path d="M44 40h32M44 48h32M44 56h20" {...LINE} opacity="0.5" />
      <circle cx="78" cy="70" r="11" fill={GOLD} />
      <circle cx="78" cy="70" r="6.5" fill="none" stroke="#fff" strokeWidth="1.5" opacity="0.8" />
      <path d="m72 78-4 14 10-6 10 6-4-14" fill={BERRY} />
      <path d="M18 14c2-3 5-3 7 0M96 12c2-3 5-3 7 0M106 34c2-3 5-3 7 0" {...LINE} opacity="0.4" />
    </>
  );
}

const SCENES: Record<Scene, () => JSX.Element> = { AllDone, QuietMorning, Offline, Importing, CourseReady, FirstCertificate };

export function Illustration({ scene, size = 120, className = "" }: { scene: Scene; size?: number; className?: string }) {
  const Draw = SCENES[scene];
  return (
    <svg
      className={`illo illo-${scene} ${className}`.trim()}
      width={size}
      height={Math.round(size * (100 / 120))}
      viewBox="0 0 120 100"
      aria-hidden="true"
      focusable="false"
      data-scene={scene}
    >
      <Draw />
    </svg>
  );
}
