import { useState } from "react";
import { toast } from "../components/Toast";
import { api } from "../api";
import { usePaged } from "../hooks/usePaged";

type StyleExample = {
  id: string;
  clientText: string;
  ownerText: string;
  source: "HISTORY" | "TAKEOVER";
  ledToSale: boolean;
  enabled: boolean;
  createdAt: string;
};

const SOURCE_LABEL: Record<string, string> = {
  HISTORY: "из прошлых переписок",
  TAKEOVER: "хозяйка ответила сама",
};

export function StylePage() {
  // Раньше грузилось разом до 100 примеров без возможности увидеть остальные
  // (историю переписок легко импортировать больше сотни) — тот же паттерн
  // подгрузки, что уже есть в Клиентах/Журнале/Чеках.
  const { rows: paged, hasMore, loadingMore, err: pagedErr, loadMore, reload: load } = usePaged<StyleExample>(
    "/admin/style",
    ""
  );
  const rows = paged ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function runImport() {
    setErr(null);
    try {
      const r = await api<{ started: boolean; note: string }>("/admin/style/import", { method: "POST" });
      toast(r.note);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    }
  }

  async function toggle(row: StyleExample) {
    setBusy(row.id);
    try {
      await api(`/admin/style/${row.id}/toggle`, { method: "POST", body: { enabled: !row.enabled } });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось изменить");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: StyleExample) {
    setBusy(row.id);
    try {
      await api(`/admin/style/${row.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>Стиль</h2>
      <p className="hint">
        Бот учится отвечать так же, как хозяйка. Промт при этом не меняется — вместо этого лучшие примеры её
        реальных ответов подмешиваются в каждый запрос как образец манеры. Новые примеры добавляются сами каждый
        раз, когда она вмешивается в разговор.
      </p>
      {(err || pagedErr) && <div className="msg err">{err ?? pagedErr}</div>}
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" onClick={runImport}>Загрузить из прошлых переписок</button>
        <button className="btn ghost" onClick={load}>Обновить</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Клиент написал</th>
            <th>Ответ хозяйки</th>
            <th>Источник</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.45 }}>
              <td className="funnel-meta">{r.clientText || "—"}</td>
              <td>{r.ownerText}</td>
              <td className="funnel-meta">
                {SOURCE_LABEL[r.source] ?? r.source}
                {r.ledToSale && <span className="chip" style={{ marginLeft: 6 }}>привёл к продаже</span>}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="btn small ghost" disabled={busy === r.id} onClick={() => toggle(r)}>
                  {r.enabled ? "Выкл" : "Вкл"}
                </button>
                <button className="btn small danger" disabled={busy === r.id} onClick={() => remove(r)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
          {paged !== null && rows.length === 0 && (
            <tr>
              <td colSpan={4} className="funnel-meta">
                Пока пусто — нажми «Загрузить из прошлых переписок».
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}
    </div>
  );
}
