/**
 * Знак и иконки панели.
 *
 * Готового логотипа у школы нет — рисуем свой: кондитерский мешок с завитком
 * крема, в фирменном винно-розовом. Это не картинка, а SVG прямо в разметке:
 * он чёткий на любом экране, красится темой и ничего не грузит по сети (внутри
 * Telegram каждый лишний запрос — заметная задержка на первом экране).
 */

export function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {/* мешок */}
        <path d="M7.5 3.5h9l-3.2 8.2a2.6 2.6 0 0 1-2.6 1.6 2.6 2.6 0 0 1-2.6-1.6Z" />
        {/* завиток крема */}
        <path d="M12 13.3v2.4M9.6 18.4c0-1.4 1.1-2.5 2.4-2.5s2.4 1.1 2.4 2.5-1.1 2.2-2.4 2.2-2.4-.8-2.4-2.2Z" />
      </svg>
    </span>
  );
}

export function Logo() {
  return (
    <div className="logo">
      <LogoMark />
      <span className="logo-text">
        <b>Shirin Sweets</b>
        <span>панель Ширин</span>
      </span>
    </div>
  );
}

/** Иконки навигации. Один стиль, одна толщина линии — иначе меню выглядит сборным. */
const ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Icons = {
  home: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M3.5 10.2 12 3.5l8.5 6.7V20a1 1 0 0 1-1 1h-4.6v-6.2H9.1V21H4.5a1 1 0 0 1-1-1Z" />
    </svg>
  ),
  money: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M4 6.5h16v11H4z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M7 12h.01M17 12h.01" />
    </svg>
  ),
  funnels: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M3.5 5h17l-6.4 7.4V20l-4.2-2.4v-5.2Z" />
    </svg>
  ),
  clients: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.6 20c0-3.2 2.6-5.2 5.9-5.2s5.9 2 5.9 5.2M16.5 6.2a3 3 0 0 1 0 5.8M18 20c0-2.3-.8-3.9-2.2-4.8" />
    </svg>
  ),
  receipts: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6L8.4 20.5 6 18.9Z" />
      <path d="M9.4 8.5h5.2M9.4 12.2h5.2" />
    </svg>
  ),
  journal: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M4.5 4.5h15v15h-15z" />
      <path d="M8 9h8M8 12.5h8M8 16h4.5" />
    </svg>
  ),
  style: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="m12 3.5 2.5 5.4 5.9.7-4.4 4 1.2 5.9-5.2-3-5.2 3 1.2-5.9-4.4-4 5.9-.7Z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7 2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 7.4 3.9l.1.1a1.6 1.6 0 0 0 2.7-1.1 2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7 2 2 0 1 1 0 4 1.6 1.6 0 0 0-1.4 1Z" />
    </svg>
  ),
  /** Статус «работает» — точка в кружке, спокойнее и строже галочки. */
  pulse: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M10.3 9.4v5.2M13.7 9.4v5.2" />
    </svg>
  ),
  attach: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M18.5 11.4 12.6 17.3a3.9 3.9 0 0 1-5.5-5.5l6.6-6.6a2.6 2.6 0 0 1 3.7 3.7l-6.6 6.6a1.3 1.3 0 0 1-1.8-1.8l5.9-5.9" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" />
    </svg>
  ),
  /** Значки каналов — рисуем сами: узнаваемая форма без фирменных логотипов. */
  instagram: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M16.8 7.2h.01" />
    </svg>
  ),
  messenger: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M12 3.6c-4.7 0-8.4 3.5-8.4 7.9 0 2.4 1.1 4.6 3 6v3.1l2.8-1.5c.8.2 1.7.3 2.6.3 4.7 0 8.4-3.5 8.4-7.9S16.7 3.6 12 3.6Z" />
      <path d="m7.7 13.6 2.7-2.8 2 2 2.9-2.9-2.7 2.8-2-2Z" />
    </svg>
  ),
  comment: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M4.5 5.5h15v10h-9l-4.5 3.5v-3.5h-1.5Z" />
    </svg>
  ),
  /** Скриншот отзыва — рамка фото со звездой поверх. */
  testimonials: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <rect x="3.5" y="4.5" width="17" height="14" rx="2" />
      <path d="M3.5 15.5 8 11l3 3 4-4.5 5.5 6" />
      <path d="m17.3 5.7.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  exit: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M15 4.5h3.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H15M11 15.5 14.5 12 11 8.5M14 12H4.5" />
    </svg>
  ),
  /** Голосовое/фото/видео на повтор — кружок-плей поверх волны звука. */
  media: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.3 9.2v5.6l4.6-2.8Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" {...ICON}>
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  ),
};
