/**
 * ЖИВЫЕ ЦВЕТНЫЕ ИЛЛЮСТРАЦИИ.
 *
 * Референс владельца был ярким за счёт цветных иконок-кружков и ФОТОГРАФИЙ
 * людей. Фото повторить нельзя не потому что «жалко красоты», а по существу:
 * там реальные лица незнакомых людей с Unsplash, вставленные в чужой макет как
 * выдуманные персонажи. Вместо этого — свои иллюстрации десертов, в фирменных
 * цветах.
 *
 * ГЕОМЕТРИЯ СИММЕТРИЧНА НАРОЧНО. Первая версия кекса была нарисована на глаз,
 * от руки — левая и правая половина крема получили разную кривизну, и на
 * реальном экране это читалось как «кривая иконка» (справедливое замечание
 * владельца). Теперь у капкейка одна общая функция-генератор: все координаты
 * зеркалятся относительно центра (x=0), так что перекос геометрически
 * невозможен — ошибиться можно только в цвете, не в форме.
 */

/** Один капкейк, отрисованный вокруг локального центра (0,0). Все x-координаты
 *  зеркальны — левая и правая половина всегда одинаковы. */
function Cupcake({
  liner,
  linerDark,
  frosting,
  frostingDark,
  cherry,
}: {
  liner: string;
  linerDark: string;
  frosting: string;
  frostingDark: string;
  cherry: string;
}) {
  return (
    <g>
      {/* стаканчик — трапеция с прямыми сторонами, симметрична по построению */}
      <path d="M-22 18 L22 18 L15 52 Q15 57 10 57 L-10 57 Q-15 57 -15 52 Z" fill={liner} />
      <path d="M-19 27h38M-17 36h34M-15 45h30" stroke={linerDark} strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      {/* крем — три одинаковых круга-шара, зеркальные позиции */}
      <circle cx="-13" cy="6" r="15" fill={frosting} />
      <circle cx="13" cy="6" r="15" fill={frosting} />
      <circle cx="0" cy="-10" r="16" fill={frosting} />
      <circle cx="-13" cy="6" r="15" stroke={frostingDark} strokeWidth="1.5" fill="none" opacity="0.35" />
      <circle cx="13" cy="6" r="15" stroke={frostingDark} strokeWidth="1.5" fill="none" opacity="0.35" />
      <circle cx="0" cy="-10" r="16" stroke={frostingDark} strokeWidth="1.5" fill="none" opacity="0.35" />
      {/* вишенка сверху, ровно по центру */}
      <path d="M0 -34c0-5 3-8 6-9" stroke={linerDark} strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="0" cy="-30" r="6.5" fill={cherry} />
      {/* посыпка — симметричные пары */}
      <circle cx="-9" cy="2" r="1.8" fill={frostingDark} />
      <circle cx="9" cy="2" r="1.8" fill={frostingDark} />
      <circle cx="0" cy="10" r="1.8" fill={frostingDark} />
    </g>
  );
}

/** Один капкейк покрупнее — для главной плитки и пустых состояний. */
export function CupcakeArt({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-40 -46 80 108" fill="none">
      <ellipse cx="0" cy="58" rx="26" ry="5" fill="#000" opacity="0.06" />
      <Cupcake
        liner="var(--pastel-orange)"
        linerDark="var(--pastel-orange-ink)"
        frosting="var(--pastel-pink)"
        frostingDark="var(--pastel-pink-ink)"
        cherry="var(--pastel-pink-ink)"
      />
    </svg>
  );
}

/** Маленький леденец-конфетти — для пустых списков, не такой заметный, как кекс. */
export function ConfettiArt({ size = 72 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none">
      <circle cx="36" cy="36" r="26" fill="var(--pastel-teal)" />
      <path d="M36 20a16 16 0 0 1 16 16" stroke="var(--pastel-teal-ink)" strokeWidth="2" strokeLinecap="round" />
      <rect x="16" y="14" width="6" height="6" rx="1.5" fill="var(--pastel-pink-ink)" transform="rotate(20 19 17)" />
      <rect x="50" y="18" width="5" height="5" rx="1.5" fill="var(--pastel-orange-ink)" transform="rotate(-15 52 20)" />
      <circle cx="14" cy="46" r="3" fill="var(--pastel-orange-ink)" />
      <circle cx="58" cy="50" r="3" fill="var(--pastel-pink-ink)" />
    </svg>
  );
}

/** Готовое пустое состояние — конфетти вместо унылой серой строки. */
export function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty">
      <ConfettiArt size={64} />
      <div className="empty-text">{text}</div>
    </div>
  );
}

/** Три капкейка в ряд — на экран входа. Один и тот же генератор, только другая
 *  раскраска и расстояние — поэтому все три гарантированно ровные. */
export function BakeryHero({ size = 96 }: { size?: number }) {
  const scale = size / 96;
  return (
    <svg width={size * 2.4} height={size} viewBox="0 0 230 96" fill="none">
      <g transform={`translate(38 52) scale(${0.62 * scale})`}>
        <Cupcake
          liner="var(--pastel-pink)"
          linerDark="var(--pastel-pink-ink)"
          frosting="var(--pastel-teal)"
          frostingDark="var(--pastel-teal-ink)"
          cherry="var(--pastel-teal-ink)"
        />
      </g>
      <g transform={`translate(115 58) scale(${0.82 * scale})`}>
        <Cupcake
          liner="var(--pastel-orange)"
          linerDark="var(--pastel-orange-ink)"
          frosting="var(--pastel-pink)"
          frostingDark="var(--pastel-pink-ink)"
          cherry="var(--pastel-pink-ink)"
        />
      </g>
      <g transform={`translate(192 52) scale(${0.62 * scale})`}>
        <Cupcake
          liner="var(--pastel-teal)"
          linerDark="var(--pastel-teal-ink)"
          frosting="var(--pastel-orange)"
          frostingDark="var(--pastel-orange-ink)"
          cherry="var(--pastel-orange-ink)"
        />
      </g>
    </svg>
  );
}
