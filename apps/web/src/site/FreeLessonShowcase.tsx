import { useEffect, useRef, useState } from "react";
import { showcaseCopy, type Lang } from "./i18n";
import { whatsappOrderUrl } from "./sales";

/** Только то, что отдаёт закрытая витрина: без видео, без количеств и без текста рецепта. */
type Item = { id: string; title: string; order: number; coverUrl: string | null; ingredients: string[] };

function Lock() {
  return (
    <svg className="showcase-lock" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z" />
    </svg>
  );
}

/** «Что ещё внутри курса»: закрытые уроки того же курса. По нажатию — фото и состав без граммов. */
export function FreeLessonShowcase({ lang }: { lang: Lang }) {
  const t = showcaseCopy[lang];
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/free-lesson/more")
      .then((r) => (r.ok ? r.json() : null))
      .then((value: { lessons?: Item[] } | null) => {
        if (active && value?.lessons?.length) setItems(value.lessons);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function close() {
    setOpen(null);
    opener.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!items) return null;
  return (
    <div className="showcase" id="free-showcase">
      <h3 className="h3">{t.title}</h3>
      <p className="muted">{t.lead}</p>
      <ul className="showcase-grid">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="showcase-card"
              onClick={(e) => {
                opener.current = e.currentTarget;
                setOpen(item);
              }}
            >
              <span className="showcase-cover">
                {item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <span className="showcase-nocover" />}
                <span className="showcase-badge">
                  <Lock />
                </span>
              </span>
              <strong>{item.title}</strong>
              <span className="muted">{t.locked}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="showcase-backdrop" onClick={close}>
          <div className="showcase-dialog card" role="dialog" aria-modal="true" aria-label={open.title} onClick={(e) => e.stopPropagation()}>
            <button ref={closeRef} type="button" className="showcase-close" onClick={close} aria-label={t.close}>
              ×
            </button>
            {open.coverUrl && <img src={open.coverUrl} alt={open.title} />}
            <h4 className="h3">{open.title}</h4>
            {open.ingredients.length > 0 && (
              <>
                <p className="muted">{t.ingredients}</p>
                <ul className="showcase-ingredients">
                  {open.ingredients.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted">{t.closedNote}</p>
            <a className="btn" href={whatsappOrderUrl("", t.prefill)} target="_blank" rel="noopener">
              {t.open}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
