import { useEffect, useState } from "react";
import { api } from "../api";
import { timeAgo } from "../format";
import { Sheet } from "./Sheet";
import { SkeletonList } from "./Skeleton";

type Msg = {
  id: string;
  direction: "IN" | "OUT";
  text: string | null;
  imageUrl?: string | null;
  byHuman: boolean;
  createdAt: string;
};

/**
 * «ПЕРЕПИСКА» — лист снизу с историей одного клиента. Нужен там, где ответить
 * по ссылке нельзя (сайт, Messenger, Instagram без имени): сестра видит, что
 * человек писал, и отвечает тем способом, который у неё есть.
 * Данные — GET /admin/contacts/:id/messages (последние 200 сообщений).
 */
export function ConversationSheet(props: { contactId: string | null; name: string; onClose: () => void }) {
  const { contactId, name, onClose } = props;
  const [rows, setRows] = useState<Msg[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!contactId) return;
    let live = true;
    setRows(null);
    setErr(null);
    api<Msg[]>(`/admin/contacts/${contactId}/messages`)
      .then((d) => live && setRows(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : "Не удалось загрузить"));
    return () => {
      live = false;
    };
  }, [contactId]);

  return (
    <Sheet open={contactId !== null} label={`Переписка: ${name}`} onClose={onClose}>
      <h3 className="more-title">{name}</h3>
      {err && <div className="msg err">{err}</div>}
      {!rows && !err && <SkeletonList rows={3} height={56} />}
      {rows && rows.length === 0 && <p className="hint">Сообщений пока нет.</p>}
      {rows && (
        <ol className="convo" aria-label="Сообщения">
          {rows.map((m) => (
            <li key={m.id} className={`convo-msg ${m.direction === "IN" ? "in" : "out"}`}>
              <span className="convo-who">{m.direction === "IN" ? "Клиент" : m.byHuman ? "Вы" : "Помощник"}</span>
              <span className="convo-text">{m.text?.trim() || (m.imageUrl ? "Фото" : "Без текста")}</span>
              <span className="convo-time">{timeAgo(m.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
