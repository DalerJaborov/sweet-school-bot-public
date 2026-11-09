import { useState } from "react";
import { api } from "../api";
import { toast } from "./Toast";

/** Массовый список личных контактов: ники Instagram и номера WhatsApp, по одному в строке. */
export function PersonalImport({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api<{ added: number; marked: number; invalid: number }>("/admin/personal/import", { method: "POST", body: { text } });
      toast(`Добавлено в список: ${r.added}. Уже писавших отмечено личными: ${r.marked}.${r.invalid ? ` Не распознано строк: ${r.invalid}.` : ""}`);
      setText("");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось сохранить список", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details style={{ marginBottom: 14 }}>
      <summary>Добавить родных и знакомых списком</summary>
      <p className="hint">Ники Instagram (без @) и номера WhatsApp, каждый с новой строки. Помощник с ними не переписывается, их сообщения остаются в истории.</p>
      <label className="field">
        <textarea aria-label="Список личных контактов" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"mama_nick\nsestra.nick\n+992900000000"} />
      </label>
      <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void save()}>
        {busy ? "Сохраняю…" : "Сохранить список"}
      </button>
    </details>
  );
}
