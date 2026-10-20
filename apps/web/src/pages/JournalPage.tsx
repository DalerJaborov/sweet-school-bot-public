import { useState } from "react";
import { type Delivery } from "../api";
import { Icons } from "../components/Brand";
import { EmptyState } from "../components/Illustrations";
import { Person } from "../components/Person";
import { timeAgo } from "../format";
import { usePaged } from "../hooks/usePaged";

/**
 * ЖУРНАЛ — лента событий воронок: кто зашёл, на чём стоит, где сорвалось.
 *
 * Была таблица из пяти колонок с полными датами и голыми идентификаторами —
 * найти в ней конкретного человека было невозможно. Теперь это лента с лицами и
 * фильтром по состоянию: «ждут кнопку» и «сбои» — то, ради чего сюда и заходят.
 */

const STATE_LABEL: Record<Delivery["state"], string> = {
  ACTIVE: "идёт",
  WAITING: "ждёт кнопку",
  DONE: "прошёл",
  FAILED: "сбой",
};

type Filter = "all" | "WAITING" | "FAILED" | "DONE";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "WAITING", label: "Ждут кнопку" },
  { id: "DONE", label: "Прошли" },
  { id: "FAILED", label: "Сбои" },
];

export function JournalPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const { rows, hasMore, loadingMore, err, loadMore } = usePaged<Delivery>("/admin/journal", "");

  // Фильтр — по уже загруженным страницам: «Показать ещё» подгружает следующую
  // порцию из ленты целиком, а не отдельно по каждому состоянию.
  const visible = (rows ?? []).filter((d) => filter === "all" || d.state === filter);

  return (
    <div className="card">
      <h2>{Icons.journal} Журнал</h2>
      <p className="hint">Кто и как проходит воронки.</p>

      <div className="seg" style={{ marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {err && <div className="msg err">{err}</div>}
      {!rows && <div className="skeleton" style={{ height: 160 }} />}
      {rows && visible.length === 0 && (
        <EmptyState text={filter === "all" ? "Пока пусто" : "В этом списке пусто"} />
      )}

      <div className="list">
        {visible.map((d) => (
          <div className="list-row" key={d.id}>
            <div className="list-main">
              <Person person={d.contact} note={`${d.funnel.name} · ${timeAgo(d.createdAt)}`} />
              {(d.lastError || d.commentText) && (
                <div className="list-sub" style={{ marginTop: 6 }}>
                  {d.lastError ? `Ошибка: ${d.lastError}` : `«${d.commentText}»`}
                </div>
              )}
            </div>
            <div className="list-actions">
              <span className={`state ${d.state}`}>{STATE_LABEL[d.state]}</span>
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}
    </div>
  );
}
