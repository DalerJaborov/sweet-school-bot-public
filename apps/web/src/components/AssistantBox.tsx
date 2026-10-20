import { useState, type FormEvent } from "react";
import { askAssistant, type AssistantAnswer, type AssistantSource, type AssistantTurn } from "../api";
import { Skeleton } from "./Skeleton";
import { toast } from "./Toast";

/**
 * «СПРОСИТЬ ПОМОЩНИЦУ» («Утро Ширин» §21) — поле под бенто на главной.
 *
 * Вопрос уходит в POST /admin/assistant/ask; модель на сервере — диспетчер
 * над закрытым набором read-only инструментов, поэтому под каждым ответом
 * есть «Откуда цифры»: список вызванных инструментов, каждый раскрывается в
 * компактную таблицу. Черновик ответа ученице — отдельной карточкой с
 * «Скопировать» и «Открыть вопросы»: помощница ничего не отправляет сама.
 * История — последние 6 реплик в состоянии компонента, на сервер уходит
 * с каждым вопросом (сервер её не хранит).
 */
const EXAMPLES = ["сколько продали на этой неделе?", "кто не открыл урок?", "напиши Мадине ответ про сливки"];
const HISTORY_LIMIT = 6;

export function AssistantBox({ onOpenQuestions }: { onOpenQuestions: () => void }) {
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<AssistantTurn[]>([]);
  const [last, setLast] = useState<{ question: string; reply: AssistantAnswer } | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setQ(text);
    try {
      const reply = await askAssistant(text, history);
      setLast({ question: text, reply });
      const turns: AssistantTurn[] = [
        { role: "user", text },
        { role: "model", text: reply.answer },
      ];
      setHistory((h) => [...h, ...turns].slice(-HISTORY_LIMIT));
      setQ("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Помощница не ответила", "error");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(q);
  }

  return (
    <section className="card assistant" aria-labelledby="assistant-title">
      <h2 id="assistant-title">Спросить помощницу</h2>
      <p className="hint">Отвечает по данным панели и показывает, откуда цифры. Ничего не отправляет без вашей кнопки.</p>
      <form className="assistant-form" onSubmit={onSubmit}>
        <input
          className="assistant-input"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Сколько продали на этой неделе? Кто не открыл урок?"
          aria-label="Вопрос помощнице"
          disabled={busy}
          autoComplete="off"
          enterKeyHint="send"
        />
        <button type="submit" className="btn" disabled={busy || !q.trim()}>
          {busy ? "Думаю…" : "Спросить"}
        </button>
      </form>
      <div className="assistant-chips" aria-label="Примеры вопросов">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="chip chip-accent assistant-chip" disabled={busy} onClick={() => void send(ex)}>
            {ex}
          </button>
        ))}
      </div>

      {busy && (
        <div className="assistant-answer" aria-busy="true" aria-label="Помощница думает" data-testid="assistant-skeleton">
          <Skeleton height={14} width="90%" className="skeleton-text" />
          <Skeleton height={14} width="70%" className="skeleton-text" />
        </div>
      )}

      {!busy && last && (
        <div className="assistant-answer" role="region" aria-live="polite" aria-label="Ответ помощницы">
          <div className="assistant-q">{last.question}</div>
          <div className="assistant-a">{last.reply.answer}</div>
          {last.reply.fallback && <div className="assistant-note">Посчитано без ИИ — по данным панели напрямую.</div>}
          {last.reply.sources.length > 0 && <Sources sources={last.reply.sources} />}
          {last.reply.draft && <DraftCard text={last.reply.draft.text} onOpenQuestions={onOpenQuestions} />}
        </div>
      )}
    </section>
  );
}

const TOOL_TITLE: Record<string, string> = {
  money: "Выручка",
  funnel: "Воронка",
  notOpened: "Не открыли урок",
  student: "Карточка ученицы",
  unansweredQuestions: "Вопросы без ответа",
  draftReply: "Черновик ответа",
  today: "Сводка «Сегодня»",
};

function Sources({ sources }: { sources: AssistantSource[] }) {
  return (
    <details className="assistant-sources">
      <summary>Откуда цифры · {sources.length}</summary>
      <ul>
        {sources.map((s, i) => (
          <li key={`${s.tool}-${i}`}>
            <details className="assistant-source">
              <summary>
                <b>{TOOL_TITLE[s.tool] ?? s.tool}</b>
                {Object.keys(s.args).length > 0 && <span className="assistant-args">{formatArgs(s.args)}</span>}
                <span className="assistant-summary">{s.summary}</span>
              </summary>
              <DataTable data={s.data} />
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

/** Значение в ячейке: вложенное — коротким JSON, дата — датой, null — «—». */
function cell(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleDateString("ru-RU");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Компактная таблица из структуры инструмента: список объектов — строки с
 * общими колонками; объект — пары ключ/значение, вложенные списки объектов
 * (byCourse, courses) — своими таблицами ниже.
 */
export function DataTable({ data }: { data: unknown }) {
  if (data == null) return <div className="assistant-empty">Пусто</div>;
  if (Array.isArray(data)) {
    if (data.length === 0) return <div className="assistant-empty">Пусто</div>;
    if (!data.every(isRecord)) return <div className="assistant-empty">{data.map(cell).join(", ")}</div>;
    const cols = [...new Set(data.flatMap((row) => Object.keys(row)))].filter((c) => !/id$/i.test(c));
    return (
      <div className="assistant-table-wrap">
        <table className="assistant-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{cell(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (isRecord(data)) {
    const scalars = Object.entries(data).filter(([k, v]) => !(Array.isArray(v) && v.length > 0 && v.every(isRecord)) && !/id$/i.test(k));
    const nested = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isRecord));
    return (
      <>
        {scalars.length > 0 && (
          <div className="assistant-table-wrap">
            <table className="assistant-table">
              <tbody>
                {scalars.map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row">{k}</th>
                    <td>{cell(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nested.map(([k, v]) => (
          <div key={k} className="assistant-nested">
            <div className="assistant-nested-title">{k}</div>
            <DataTable data={v} />
          </div>
        ))}
      </>
    );
  }
  return <div className="assistant-empty">{cell(data)}</div>;
}

function DraftCard({ text, onOpenQuestions }: { text: string; onOpenQuestions: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard?.writeText(text);
      toast("Черновик скопирован — вставьте в ответ ученице");
    } catch {
      toast("Не удалось скопировать", "error");
    }
  }
  return (
    <div className="assistant-draft" data-testid="assistant-draft">
      <div className="assistant-draft-title">Черновик ответа — не отправлен</div>
      <div className="assistant-draft-text">{text}</div>
      <div className="queue-actions">
        <button type="button" className="btn small" onClick={() => void copy()}>
          Скопировать
        </button>
        <button type="button" className="btn quiet small" onClick={onOpenQuestions}>
          Открыть вопросы
        </button>
      </div>
    </div>
  );
}
