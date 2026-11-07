import { useEffect, useState } from "react";
import { api } from "../api";

type State = {
  enabled: boolean;
  lessonId: string;
  lessons: { id: string; title: string }[];
  leads: { id: string; name: string; phone: string; createdAt: string }[];
};
export function FreeLessonSettings() {
  const [data, setData] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<State>("/admin/free-lesson")
      .then(setData)
      .catch(() => setError("Не удалось загрузить бесплатный урок"));
  }, []);
  async function save(next: State) {
    const previous = data;
    setData(next);
    setBusy(true);
    setError("");
    try {
      await api("/admin/free-lesson", { method: "PUT", body: { enabled: next.enabled, lessonId: next.lessonId } });
    } catch {
      setData(previous);
      setError("Не удалось сохранить. Попробуйте снова.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="free-lesson-settings">
      <h3 id="free-lesson-settings">Бесплатный урок</h3>
      <p className="hint">
        После имени и телефона посетитель сможет посмотреть один урок. Платные курсы останутся закрыты.
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <label>
            Урок
            <select
              value={data.lessonId}
              disabled={busy}
              onChange={(e) =>
                void save({ ...data, lessonId: e.target.value, enabled: e.target.value ? data.enabled : false })
              }
            >
              <option value="">Выберите урок</option>
              {data.lessons.map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {lesson.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            role="switch"
            aria-checked={data.enabled}
            disabled={busy || !data.lessonId}
            onClick={() => void save({ ...data, enabled: !data.enabled })}
          >
            {data.enabled ? "Бесплатный урок включён" : "Бесплатный урок выключен"}
          </button>
          {!data.lessons.length && <p>Сначала загрузите видео урока в активный курс.</p>}
          <details>
            <summary>
              Заявки на бесплатный урок ({data.leads.length}
              {data.leads.length === 50 ? "+" : ""})
            </summary>
            {!data.leads.length ? (
              <p>Заявок пока нет.</p>
            ) : (
              <ul>
                {data.leads.map((lead) => (
                  <li key={lead.id}>
                    {lead.name} · {lead.phone} · {new Date(lead.createdAt).toLocaleDateString("ru")}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
    </section>
  );
}
