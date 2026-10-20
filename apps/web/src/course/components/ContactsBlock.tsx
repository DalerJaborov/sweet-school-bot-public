import type { SchoolContacts } from "../api";
import type { Dict } from "../i18n";

type ContactKind = "telegram" | "whatsapp" | "instagram";
type ContactLink = { url: string; label: string; kind: ContactKind };

/**
 * Контакты живого человека — ряд круглых иконок с подписями (дизайн
 * 03.09.2026). Пустые не рисуем: кнопка в никуда хуже её отсутствия.
 */
export function ContactsBlock({ t, school }: { t: Dict; school?: SchoolContacts }) {
  const links = [
    { url: school?.telegram, label: t.telegramGroup, kind: "telegram" as const },
    { url: school?.whatsapp, label: t.whatsapp, kind: "whatsapp" as const },
    { url: school?.instagram, label: t.instagram, kind: "instagram" as const },
  ].filter((l): l is ContactLink => Boolean(l.url));
  if (links.length === 0) return null;
  return (
    <section className="contacts" aria-labelledby="contacts-h">
      <h2 id="contacts-h">{t.contacts}</h2>
      <div className="contacts-links">
        {links.map((l) => (
          // Ссылка выглядит кнопкой, но остаётся ссылкой: длинное нажатие даёт
          // «открыть в новой вкладке», и отнимать это у человека незачем.
          <a key={l.url} className="contact" href={l.url} target="_blank" rel="noreferrer noopener">
            <span className="contact-icon" aria-hidden="true">
              <ContactGlyph kind={l.kind} />
            </span>
            <span className="contact-label">{l.label}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

/** Простые контурные значки: узнаются по форме, перекрашиваются токенами. */
function ContactGlyph({ kind }: { kind: ContactKind }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    focusable: "false" as const,
  };
  if (kind === "telegram") {
    return (
      <svg {...common}>
        <path
          d="M21 4 3 11l6 2 2 6 3.5-4.5L18 17z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "whatsapp") {
    return (
      <svg {...common}>
        <path
          d="M4 20l1.3-3.8A8.5 8.5 0 1 1 8.6 19z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.8" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
    </svg>
  );
}
