import { useEffect, useState } from "react";
import { toast } from "../components/Toast";
import { Icons } from "../components/Brand";
import { confirmDialog } from "../components/ConfirmDialog";
import { confirmLeave } from "../components/UnsavedGuard";
import { FunnelEditor } from "../components/FunnelEditor";
import { api, type Funnel } from "../api";

function emptyFunnel(trigger: "COMMENT" | "DM"): Funnel {
  return {
    name: trigger === "COMMENT" ? "Новая воронка с комментария" : "Новая воронка из директа",
    enabled: false,
    trigger,
    mediaIds: [],
    keywords: [],
    anyComment: false,
    startTag: "kurs_started",
    repeatAfterDays: 30,
    steps: [{ order: 1, delaySeconds: 0, text: "", buttons: [], stopAfter: false }],
  };
}

export function FunnelsPage() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [editing, setEditing] = useState<Funnel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Какая именно воронка сейчас в процессе действия — блокирует ЕЁ кнопки, а не
   *  все сразу, и не даёт второму быстрому тапу отправить второй запрос. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api<Funnel[]>("/admin/funnels")
      .then(setFunnels)
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function save(funnel: Funnel) {
    if (saving) return; // защита от двойного тапа «Сохранить»
    setSaving(true);
    setErr(null);
    try {
      if (funnel.id) await api(`/admin/funnels/${funnel.id}`, { method: "PUT", body: funnel });
      else await api("/admin/funnels", { method: "POST", body: funnel });
      setEditing(null);
      toast("Воронка сохранена");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  }

  async function cancelEdit() {
    if (!(await confirmLeave())) return;
    setEditing(null);
  }

  async function remove(funnel: Funnel) {
    if (!funnel.id || busyId) return;
    const ok = await confirmDialog({
      title: `Удалить воронку «${funnel.name}»?`,
      message: "Журнал её выдач тоже удалится.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusyId(funnel.id);
    try {
      await api(`/admin/funnels/${funnel.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusyId(null);
    }
  }

  async function duplicate(funnel: Funnel) {
    if (!funnel.id || busyId) return;
    setBusyId(funnel.id);
    try {
      await api(`/admin/funnels/${funnel.id}/duplicate`, { method: "POST" });
      toast("Копия создана (выключена) — поменяй ролик и тексты");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  if (editing) {
    return (
      <FunnelEditor
        key={editing.id ?? "new"}
        funnel={editing}
        onCancel={cancelEdit}
        onSave={save}
        saving={saving}
        error={err}
      />
    );
  }

  return (
    <div className="card">
      <h2>{Icons.funnels} Воронки</h2>
      <p className="hint">
        «С комментария» — человек комментирует публикацию, бот пишет ему в директ.
        «Из директа» — человек сам пишет первым.
      </p>
      {err && <div className="msg err">{err}</div>}
      {funnels.map((f) => (
        <div className="funnel-item" key={f.id}>
          <div>
            <div className="funnel-name">{f.name}</div>
            <div className="funnel-meta">
              {f.trigger === "COMMENT" ? "С комментария" : "Из директа"} · шагов: {f.steps.length} · прошло людей:{" "}
              {f._count?.deliveries ?? 0}
              {f.trigger === "COMMENT" &&
                (f.mediaIds.length > 0 ? ` · роликов: ${f.mediaIds.length}` : " · под любым роликом")}
            </div>
          </div>
          <div className="spacer" />
          <span className={`state ${f.enabled ? "DONE" : "FAILED"}`}>{f.enabled ? "Включена" : "Выключена"}</span>
          <button className="btn small ghost" disabled={busyId === f.id} onClick={() => setEditing(f)}>
            Изменить
          </button>
          <button className="btn small ghost" disabled={busyId === f.id} onClick={() => duplicate(f)}>
            {busyId === f.id ? "…" : "Копия"}
          </button>
          <button className="btn small danger" disabled={busyId === f.id} onClick={() => remove(f)}>
            Удалить
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => setEditing(emptyFunnel("COMMENT"))}>+ С комментария</button>
        <button className="btn ghost" onClick={() => setEditing(emptyFunnel("DM"))}>+ Из директа</button>
      </div>
    </div>
  );
}
