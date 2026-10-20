import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { search, type SearchResponse } from "../api";
import { Illustration } from "./Illustration";

/**
 * ⌘K / ПОИСК СВЕРХУ («Утро Ширин» §18). На ПК — ⌘K/Ctrl+K, на телефоне —
 * лупа в шапке (SearchButton). Одна строка: «мадина» → карточка ученицы,
 * «цена» → «Тексты и цены», «чек» → очередь чеков, «тирамису» → урок.
 *
 * Открытие — через модульный emitter (как toast()): кнопке в шапке и
 * горячей клавише не нужно знать, где смонтирована палитра. Запрос уходит
 * после паузы 200 мс и не короче двух символов (тот же порог, что на сервере).
 * Доступность: role="dialog" + combobox/listbox, стрелки ходят по плоскому
 * списку через aria-activedescendant, Esc закрывает, фокус возвращается туда,
 * откуда открыли.
 */
export type SearchHit =
  | { type: "student"; id: string; title: string; sub: string }
  | { type: "lesson"; id: string; title: string; sub: string }
  | { type: "section"; tab: string; title: string; sub: string };

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

const openers = new Set<() => void>();
export function openCommandPalette(): void {
  for (const fn of openers) fn();
}

function isHotkey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

const GROUP_TITLE: Record<SearchHit["type"], string> = { student: "Ученицы", lesson: "Уроки", section: "Разделы" };

function flatten(r: SearchResponse): SearchHit[] {
  return [
    ...r.sections.map<SearchHit>((s) => ({ type: "section", tab: s.tab, title: s.title, sub: "раздел" })),
    ...r.students.map<SearchHit>((s) => ({
      type: "student",
      id: s.id,
      title: s.handle,
      sub: [s.name, s.paid ? "оплатила" : null, s.phone].filter(Boolean).join(" · ") || "ученица",
    })),
    ...r.lessons.map<SearchHit>((l) => ({ type: "lesson", id: l.id, title: l.title, sub: `урок ${l.order} · ${l.course}` })),
  ];
}

export const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </svg>
);

/** Лупа в шапке телефона и подсказка «⌘K» в сайдбаре — одна кнопка, две одежды. */
export function SearchButton({ variant = "icon" }: { variant?: "icon" | "bar" }) {
  if (variant === "bar") {
    return (
      <button type="button" className="search-bar" onClick={openCommandPalette} aria-keyshortcuts="Control+K Meta+K">
        {SearchIcon}
        <span>Поиск</span>
        <kbd>⌘K</kbd>
      </button>
    );
  }
  return (
    <button type="button" className="btn quiet small icon-btn" onClick={openCommandPalette} aria-label="Поиск" title="Поиск (Ctrl+K)">
      {SearchIcon}
    </button>
  );
}

export function CommandPalette({ onSelect }: { onSelect: (hit: SearchHit) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setResult(null);
    setActive(0);
    restoreFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const show = () => {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    openers.add(show);
    const onKey = (e: KeyboardEvent) => {
      if (!isHotkey(e)) return;
      e.preventDefault();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openers.delete(show);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Пауза после последней буквы; устаревший ответ не перезаписывает свежий.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < MIN_QUERY) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      search(query)
        .then((r) => {
          if (cancelled) return;
          setResult(r);
          setActive(0);
        })
        .catch(() => !cancelled && setResult({ q: query, students: [], lessons: [], sections: [] }))
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const hits = useMemo(() => (result ? flatten(result) : []), [result]);

  const pick = useCallback(
    (hit: SearchHit) => {
      close();
      onSelect(hit);
    },
    [close, onSelect]
  );

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${active}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hits.length) setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) pick(hit);
    }
  };

  const query = q.trim();
  const empty = result && hits.length === 0 && !loading;
  let index = -1;
  const groups = (["section", "student", "lesson"] as const)
    .map((type) => ({ type, items: hits.filter((h) => h.type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="cmdk-backdrop" onMouseDown={close}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Поиск по панели" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="cmdk-input-row">
          {SearchIcon}
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={hits.length ? `cmdk-opt-${active}` : undefined}
            placeholder="Ученица, урок или раздел…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn quiet small" onClick={close} aria-label="Закрыть поиск">
            Esc
          </button>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Результаты" ref={listRef} aria-busy={loading || undefined}>
          {query.length < MIN_QUERY && <div className="cmdk-hint">Наберите хотя бы две буквы: ник, имя, телефон, урок или раздел.</div>}
          {empty && (
            <div className="cmdk-empty">
              <Illustration scene="QuietMorning" size={72} />
              <span>Ничего не нашлось по «{query}»</span>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.type} className="cmdk-group" role="group" aria-label={GROUP_TITLE[g.type]}>
              <div className="cmdk-group-title">{GROUP_TITLE[g.type]}</div>
              {g.items.map((hit) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={`${hit.type}:${hit.type === "section" ? hit.tab : hit.id}`}
                    id={`cmdk-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`cmdk-item ${i === active ? "active" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(hit)}
                  >
                    <span className="cmdk-item-title">{hit.title}</span>
                    <span className="cmdk-item-sub">{hit.sub}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
