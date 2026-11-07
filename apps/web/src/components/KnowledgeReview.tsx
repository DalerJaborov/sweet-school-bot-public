import { useState } from "react";
import { api } from "../api";

type Example = { id: string; studentText: string; ownerText: string; courseId: string | null; approvedForAnswer: boolean; eligible: boolean; reviewHash: string };
type Page = { examples: Example[]; courses: { id: string; title: string }[]; nextCursor: string | null };

export function KnowledgeReview() {
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  async function load(after = "", approved = approvedOnly) {
    setLoading(true); setError("");
    try {
      const result = await api<Page>(`/admin/v1/knowledge/examples?approved=${approved}&after=${encodeURIComponent(after)}`);
      setPage(result);
      setSelected(Object.fromEntries(result.examples.map((row) => [row.id, row.courseId ?? ""])));
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось загрузить ответы"); }
    finally { setLoading(false); }
  }

  async function approve(row: Example, value: boolean) {
    setSaving(row.id); setError("");
    try {
      await api(`/admin/v1/knowledge/examples/${encodeURIComponent(row.id)}`, { method: "POST", body: { approved: value, ...(value ? { courseId: selected[row.id], reviewHash: row.reviewHash } : {}) } });
      setPage((current) => current ? { ...current, examples: current.examples.map((item) => item.id === row.id ? { ...item, approvedForAnswer: value, courseId: value ? selected[row.id] : null } : item) } : current);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить решение"); }
    finally { setSaving(null); }
  }

  return <details className="card" onToggle={(event) => { if (event.currentTarget.open && !page && !loading) void load(); }}>
    <summary style={{ cursor: "pointer", fontWeight: 600 }}>Проверить учебные ответы</summary>
    <p>Проверьте смысл и цифры, выберите курс и разрешите повтор ответа. Материалы доступны только ученицам этого курса.</p>
    <label><input type="checkbox" checked={approvedOnly} disabled={loading || saving !== null} onChange={(event) => { setApprovedOnly(event.target.checked); void load("", event.target.checked); }} /> Показать уже одобренные</label>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Загружаем ответы…</p>}
    {!loading && page?.examples.length === 0 && <p>В этом списке больше нет ответов.</p>}
    {!loading && page?.examples.map((row) => <section key={row.id} style={{ padding: "16px 0", borderBottom: "1px solid #ddd", overflowWrap: "anywhere" }}>
      <p style={{ whiteSpace: "pre-wrap" }}><strong>Вопрос:</strong> {row.studentText}</p>
      <p style={{ whiteSpace: "pre-wrap" }}><strong>Ответ:</strong> {row.ownerText}</p>
      <label style={{ display: "block" }}>Курс<br />
        <select aria-label={`Курс для ответа ${row.id}`} value={selected[row.id] ?? ""} disabled={row.approvedForAnswer || saving === row.id} style={{ maxWidth: "100%" }} onChange={(event) => setSelected((current) => ({ ...current, [row.id]: event.target.value }))}>
          <option value="">Выберите курс</option>
          {page.courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
        </select>
      </label>
      {!row.eligible && <p>Слишком короткий ответ или вопрос без контекста. Автоматически повторять его нельзя.</p>}
      <label style={{ display: "block", marginTop: 10 }}><input type="checkbox" checked={row.approvedForAnswer} disabled={saving !== null || (!row.approvedForAnswer && (!row.eligible || !selected[row.id]))} onChange={(event) => void approve(row, event.target.checked)} /> Ответ проверен: разрешаю повторять для выбранного курса</label>
    </section>)}
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
      <button type="button" className="btn btn-soft" disabled={loading || saving !== null} onClick={() => void load()}>В начало списка</button>
      {page?.nextCursor && <button type="button" className="btn" disabled={loading || saving !== null} onClick={() => void load(page.nextCursor!)}>Следующие ответы</button>}
    </div>
  </details>;
}
