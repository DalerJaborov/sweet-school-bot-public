import { useEffect, useState } from "react";
import { api } from "../api";
import { Switch } from "./Switch";
import { toast } from "./Toast";

type Settings = { videoLibraryEnabled?: string; videoLibrary?: string };

/** Та же проверка, что на сервере (ai/videoLibrary.ts, libraryError), но коротко: чтобы битый список не сохранился молча. */
export function videoLibraryProblem(raw: string): string | null {
  if (!raw.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "Это не JSON: пропущена запятая, скобка или кавычка.";
  }
  if (!Array.isArray(data)) return "Список должен начинаться с [ и заканчиваться ].";
  for (let i = 0; i < data.length; i++) {
    const e = data[i] as Record<string, unknown> | null;
    const cap = e?.caption as { ru?: unknown; tg?: unknown } | undefined;
    const okUrl = typeof e?.url === "string" && /^(https:\/\/[^/]+)?\/(img|video)\/[\w\-./]+\.mp4$/i.test(e.url);
    if (!e || typeof e.id !== "string" || (e.kind !== "dessert" && e.kind !== "howto") || !okUrl || typeof cap?.ru !== "string" || typeof cap?.tg !== "string") {
      return `Ролик №${i + 1}: нужны id, kind («dessert» или «howto»), адрес .mp4 вида /video/… и подписи ru и tg.`;
    }
    if (e.kind === "dessert" && !(Array.isArray(e.keywords) && e.keywords.length)) return `Ролик №${i + 1}: для десерта нужны keywords.`;
  }
  return null;
}

/** «Видео для клиентов»: рубильник и список роликов. Тумблер сохраняется сразу, список — кнопкой. */
export function VideoLibrarySettings() {
  const [enabled, setEnabled] = useState(false);
  const [list, setList] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const problem = videoLibraryProblem(list);

  useEffect(() => {
    api<Settings>("/admin/settings")
      .then((s) => {
        setEnabled(s.videoLibraryEnabled === "true");
        setList(s.videoLibrary ?? "");
        setSaved(s.videoLibrary ?? "");
      })
      .catch(() => {});
  }, []);

  async function flip(next: boolean) {
    setEnabled(next);
    try {
      await api("/admin/settings", { method: "PUT", body: { videoLibraryEnabled: String(next) } });
    } catch (e) {
      setEnabled(!next);
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    }
  }

  async function save() {
    if (problem) return;
    setSaving(true);
    try {
      await api("/admin/settings", { method: "PUT", body: { videoLibrary: list } });
      setSaved(list);
      toast("Список роликов сохранён", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" aria-label="Видео для клиентов">
      <h3 className="more-title">Видео для клиентов</h3>
      <Switch
        checked={enabled}
        onChange={(next) => void flip(next)}
        label="Бот присылает ролики десертов"
        hint="Выключено по умолчанию. Один показ каждого вида за разговор; про оплату и цену ролики не шлёт."
        testId="switch-videoLibraryEnabled"
      />
      <label>
        Список роликов (JSON)
        <textarea value={list} onChange={(e) => setList(e.target.value)} rows={8} spellCheck={false} aria-invalid={!!problem} />
      </label>
      {problem && (
        <p role="alert" className="hint">
          {problem}
        </p>
      )}
      <p className="hint">Пусто — используются два готовых превью уроков. Подробности и пример — docs/video-library.md.</p>
      <button className="btn" onClick={() => void save()} disabled={saving || !!problem || list === saved}>
        {saving ? "Сохраняю…" : "Сохранить список"}
      </button>
    </section>
  );
}
