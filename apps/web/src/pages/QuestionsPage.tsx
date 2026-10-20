import { useCallback, useEffect, useState } from "react";
import { api, type ChatRow, type DraftResponse } from "../api";
import { Icons } from "../components/Brand";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { timeAgo } from "../format";

/**
 * INBOX ВОПРОСОВ УЧЕНИЦ («Утро Ширин» §6) — вопросы из приложения, на
 * которые ещё не ответили. Раньше в панели этого не было вовсе: ответить
 * можно было только реплаем в Telegram. Здесь — вопрос, урок, поле ответа и
 * «Отправить»; уходит тем же путём (POST /admin/course-chat/:id/reply →
 * chat.ts answerFromPanel), ученица получает ответ в приложении.
 *
 * «Черновик от ИИ» (волна 2): помощник по рецептам собирает ответ из
 * рецептов и расшифровок курса и кладёт его в поле — не отправляет. Рядом
 * пометка, по чему он собран («по рецепту урока 7»), чтобы Ширин видела,
 * откуда взялись граммовки, прежде чем жать «Отправить».
 */
export function QuestionsPage() {
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    api<{ unanswered: number; rows: ChatRow[] }>("/admin/course-chat")
      .then((d) => setRows(d.rows))
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const unanswered = (rows ?? []).filter((r) => r.fromStudent && !r.answered);
  const history = (rows ?? []).filter((r) => !(r.fromStudent && !r.answered));

  return (
    <div className="card">
      <h2>{Icons.comment} Вопросы учениц</h2>
      <p className="hint">Из приложения с уроками. Ответ уходит ученице прямо в приложение — так же, как реплай в Telegram.</p>

      {err && !rows && <OfflineState error={err} onRetry={load} />}
      {err && rows && <div className="msg err">{err}</div>}
      {!rows && !err && <SkeletonList rows={2} height={150} />}
      {rows && unanswered.length === 0 && (
        <EmptyState scene="AllDone" title="Вопросов без ответа нет" hint="Все ученицы получили ответ. Новый вопрос появится здесь и на главной." />
      )}

      <div className="queue">
        {unanswered.map((q) => (
          <QuestionReply key={q.id} row={q} onSent={load} />
        ))}
      </div>

      {history.length > 0 && (
        <>
          <button type="button" className="btn quiet wide" style={{ marginTop: 14 }} onClick={() => setShowAnswered((v) => !v)}>
            {showAnswered ? "Скрыть историю" : `История (${history.length})`}
          </button>
          {showAnswered && (
            <div className="list" style={{ marginTop: 8 }}>
              {history.map((m) => (
                <div className="list-row" key={m.id}>
                  <div className="list-main">
                    <div className="list-title">
                      {m.fromStudent ? m.who : m.byBot ? "бот" : "Ширин"}
                      {m.lesson && <span className="chip" style={{ marginLeft: 8 }}>{m.lesson}</span>}
                    </div>
                    <div className="list-sub" style={{ whiteSpace: "normal" }}>{m.text}</div>
                  </div>
                  <span className="funnel-meta">{timeAgo(m.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QuestionReply({ row, onSent }: { row: ChatRow; onSent: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  /** Пометка, по чему собран черновик ИИ; гаснет, как только текст правят. */
  const [source, setSource] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    try {
      await api(`/admin/course-chat/${row.id}/reply`, { method: "POST", body: { text: draft.trim() } });
      toast(`Ответ ушёл ${row.who}`);
      setDraft("");
      setSource(null);
      onSent();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось отправить", "error");
    } finally {
      setBusy(false);
    }
  }

  async function askDraft() {
    setDrafting(true);
    try {
      const r = await api<DraftResponse>(`/admin/course-chat/${row.id}/draft`, { method: "POST" });
      if (r.draft === null) {
        toast(r.note, "error");
        return;
      }
      setDraft(r.draft);
      setSource(r.source);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Черновик не собрался", "error");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="queue-card">
      <div className="queue-head">
        <span className="queue-who">{row.who}</span>
        {row.lesson && <span className="chip">{row.lesson}</span>}
        <span className="queue-time">{timeAgo(row.createdAt)}</span>
      </div>
      <div className="queue-question">{row.text}</div>
      <div className="reply-box">
        {source && <span className="draft-note">Черновик ИИ {source} — проверьте перед отправкой</span>}
        <textarea
          className="reply-input"
          rows={3}
          value={draft}
          placeholder="Ответ ученице…"
          aria-label={`Ответ для ${row.who}`}
          onChange={(e) => {
            setDraft(e.target.value);
            setSource(null);
          }}
        />
        <div className="queue-actions">
          <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={() => void send()}>
            {busy ? "Отправляю…" : "Отправить"}
          </button>
          <button type="button" className="btn ghost" disabled={drafting || busy} onClick={() => void askDraft()}>
            {drafting ? "Думаю…" : "Черновик от ИИ"}
          </button>
        </div>
      </div>
    </div>
  );
}
