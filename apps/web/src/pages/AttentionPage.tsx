import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { timeAgo } from "../format";

/**
 * «НУЖЕН ВАШ ОТВЕТ» — чаты WhatsApp, где бот не смог ответить.
 * GET /admin/v1/conversations/attention; кнопки — POST …/:id/answered
 * («Ответила сама») и …/:id/return-to-bot («Вернуть боту»).
 */
export type AttentionChat = {
  contactId: string;
  name: string;
  lastText: string;
  kind: "text" | "photo" | "voice" | "file";
  reason: string;
  count: number;
  at: string;
};

const KIND_TEXT: Record<AttentionChat["kind"], string> = { text: "", photo: "Клиент прислал фото", voice: "Клиент прислал голосовое", file: "Клиент прислал файл" };

export function AttentionPage(props: { onChange?: () => void }) {
  const { onChange } = props;
  const [chats, setChats] = useState<AttentionChat[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api<{ chats: AttentionChat[] }>("/admin/v1/conversations/attention")
      .then((d) => setChats(d.chats))
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  async function act(chat: AttentionChat, path: "answered" | "return-to-bot", done: string) {
    setBusy(chat.contactId);
    try {
      await api(`/admin/v1/conversations/${encodeURIComponent(chat.contactId)}/${path}`, { method: "POST", body: {} });
      toast(done);
      setChats((list) => (list ?? []).filter((c) => c.contactId !== chat.contactId));
      onChange?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не получилось, попробуйте ещё раз", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>Нужен ваш ответ</h2>
      <p className="hint">Здесь клиенты из WhatsApp, которым бот не смог ответить. Откройте чат в WhatsApp и напишите сами.</p>

      {err && !chats && <OfflineState error={err} onRetry={load} />}
      {!chats && !err && <SkeletonList rows={2} height={150} />}
      {chats && chats.length === 0 && <EmptyState scene="AllDone" title="Все клиенты получили ответ" hint="Если бот не сможет ответить, клиент появится здесь." />}

      <div className="queue">
        {(chats ?? []).map((c) => (
          <div className="queue-card" key={c.contactId}>
            <div className="queue-head">
              <span className="queue-who">{c.name}</span>
              <span className="queue-time">{timeAgo(c.at)}</span>
            </div>
            <div className="queue-question">
              {KIND_TEXT[c.kind] && <strong>{KIND_TEXT[c.kind]}. </strong>}
              {c.lastText || (c.kind === "text" ? "Без текста" : "")}
            </div>
            <p className="hint">Почему: {c.reason}{c.count > 1 ? ` · Сообщений без ответа: ${c.count}` : ""}</p>
            <div className="queue-actions">
              <button type="button" className="btn" disabled={busy === c.contactId} onClick={() => void act(c, "answered", "Хорошо, бот в этом чате молчит")}>
                Ответила сама
              </button>
              <button type="button" className="btn ghost" disabled={busy === c.contactId} onClick={() => void act(c, "return-to-bot", "Бот ответит на следующее сообщение клиента")}>
                Вернуть боту
              </button>
            </div>
          </div>
        ))}
      </div>
      {chats && chats.length > 0 && (
        <p className="hint">«Ответила сама» — бот в этом чате молчит. «Вернуть боту» — он снова отвечает, начиная со следующего сообщения клиента.</p>
      )}
    </div>
  );
}
