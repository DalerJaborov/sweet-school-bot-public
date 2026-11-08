import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { Sheet } from "./Sheet";

/**
 * «ВЫДАТЬ ССЫЛКУ НА УРОКИ» — лист снизу на экране «Сегодня» (08.11.2026).
 *
 * Три коротких шага: найти человека → выбрать «В Telegram» или «На сайт» →
 * получить ссылку и переслать. Поиск ничего не выдаёт; ссылка рождается только
 * по нажатию на способ. Новая ссылка на сайт гасит прежнюю, приглашение в
 * Telegram — одноразовое. Если человек уже в группе, сервер приглашение не даст
 * и объяснит почему (GET/POST /admin/access-link/*, course/ownerLink.ts).
 */
type Person = { id: string; handle: string; name: string | null; courses: string[] };
type Issued = { kind: "web"; url: string } | { kind: "telegram"; links: { course: string; url: string }[] };

const COURSE_NAME: Record<string, string> = { COURSE50: "Арт-десерты", COURSE70: "21 рецепт" };
const courseName = (c: string) => COURSE_NAME[c] ?? c;

export function AccessLinkSheet(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const pending = useRef(false);
  // Закрыли лист, пока шёл запрос: его ответ уже не нужен (иначе ссылка одного человека всплывёт под другим).
  const epoch = useRef(0);

  function close() {
    epoch.current += 1;
    setQuery("");
    setPeople(null);
    setPerson(null);
    setIssued(null);
    setError(null);
    setCopied(null);
    onClose();
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    if (pending.current || query.trim().length < 2) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const mine = epoch.current;
      const d = await api<{ people: Person[] }>(`/admin/access-link/search?q=${encodeURIComponent(query.trim())}`);
      if (mine === epoch.current) setPeople(d.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось найти");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function issue(kind: "web" | "telegram") {
    if (!person || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const mine = epoch.current;
      const d = await api<Issued>("/admin/access-link/issue", { method: "POST", body: { contactId: person.id, kind } });
      if (mine === epoch.current) setIssued(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось выдать ссылку");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setError("Не удалось скопировать. Выделите ссылку и скопируйте вручную.");
    }
  }

  async function share(url: string) {
    try {
      await navigator.share({ text: "Ваша личная ссылка на уроки Ширин", url });
    } catch {
      // человек закрыл окно «Поделиться» — это не ошибка
    }
  }

  const links: { label: string; url: string }[] = issued
    ? issued.kind === "web"
      ? [{ label: "Ссылка на сайт", url: issued.url }]
      : issued.links.map((l) => ({ label: `Приглашение в группу «${courseName(l.course)}»`, url: l.url }))
    : [];
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  return (
    <Sheet open={open} label="Выдать ссылку на уроки" onClose={close}>
      <h3 className="more-title">Выдать ссылку на уроки</h3>

      {!person && (
        <form onSubmit={(e) => void search(e)} className="access-form">
          <label className="field">
            <span>Ник или имя ученицы</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="например, malika"
              autoComplete="off"
              autoFocus
            />
          </label>
          <button type="submit" className="btn wide" disabled={busy || query.trim().length < 2}>
            {busy ? "Ищу…" : "Найти"}
          </button>
          {people && people.length === 0 && (
            <p className="hint">Не нашла среди тех, кто оплатил курс. Проверьте ник или имя.</p>
          )}
          {people && people.length > 0 && (
            <ul className="access-people" aria-label="Найденные">
              {people.map((p) => (
                <li key={p.id}>
                  <button type="button" className="btn ghost wide access-person" onClick={() => setPerson(p)}>
                    <b>
                      {p.handle}
                      {p.name ? ` · ${p.name}` : ""}
                    </b>
                    <span className="hint">{p.courses.map(courseName).join(", ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}

      {person && !issued && (
        <div className="access-form">
          <p className="today-sub">
            <b>
              {person.handle}
              {person.name ? ` · ${person.name}` : ""}
            </b>
            <br />
            Куда выдать личную ссылку?
          </p>
          <button
            type="button"
            className="btn wide today-action"
            disabled={busy}
            onClick={() => void issue("telegram")}
          >
            В Telegram
          </button>
          <button
            type="button"
            className="btn ghost wide today-action"
            disabled={busy}
            onClick={() => void issue("web")}
          >
            На сайт
          </button>
          <p className="hint">«На сайт» — прошлая ссылка на сайт перестанет работать, новая откроется на первом телефоне, где её нажмут. «В Telegram» сайтовую ссылку не трогает.</p>
          <button type="button" className="btn ghost small" onClick={() => setPerson(null)}>
            Выбрать другого человека
          </button>
        </div>
      )}

      {issued && (
        <div className="access-form">
          {person && (
            <p className="today-sub">
              Для: <b>{person.handle}{person.name ? ` · ${person.name}` : ""}</b>
            </p>
          )}
          {links.map((l) => (
            <div key={l.url} className="field">
              <span>{l.label}</span>
              <input readOnly value={l.url} onFocus={(e) => e.currentTarget.select()} aria-label={l.label} />
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <button type="button" className="btn small" onClick={() => void copy(l.url)}>
                  {copied === l.url ? "Скопировано" : "Скопировать"}
                </button>
                {canShare && (
                  <button type="button" className="btn ghost small" onClick={() => void share(l.url)}>
                    Переслать
                  </button>
                )}
              </div>
            </div>
          ))}
          <p className="hint">Перешлите ссылку только этой ученице. Закроете окно — ссылку можно выдать заново.</p>
          <button type="button" className="btn ghost wide" onClick={close}>
            Готово
          </button>
        </div>
      )}

      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
