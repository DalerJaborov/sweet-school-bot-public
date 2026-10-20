import { useCallback, useEffect, useRef, useState } from "react";
import { loadChat, sendChat, type ChatMessage } from "../api";
import type { Dict } from "../i18n";
import { Illustration } from "../components/Illustration";
import { Composer } from "./Composer";
import { enqueue, flushQueue, readQueue, type QueuedChat } from "./queue";

/**
 * ЧАТ С УЧИТЕЛЬНИЦЕЙ — лента и поле. Одна на все курсы человека.
 *
 * Отвечает сначала бот — но только её же прошлым ответом на близко совпавший
 * вопрос, ничего не сочиняя (та же логика, что уже год работает в учебной
 * Telegram-группе). Не нашёл совпадения — молчит, и вопрос уходит Ширин в
 * Telegram; её ответ появляется здесь же. Ученице не показываем, кто именно
 * ответил: для неё это ответ школы. Владелец различает их в панели.
 *
 * Лента — role=log с aria-live: новый ответ читалка объявит сама. Сообщения,
 * написанные без сети, видны сразу с пометкой и уходят при `online`.
 * Компонент встраивается и в страницу чата, и во вкладку «Вопрос» урока
 * (тогда `lessonId` — урок, о котором спрашивают).
 */
export function ChatThread({ t, lessonId, online }: { t: Dict; lessonId: string | null; online: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [queued, setQueued] = useState<QueuedChat[]>(() => readQueue());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadChat()
      .then((r) => {
        if (!cancelled) setMessages(r.messages);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Появилась сеть — досылаем то, что писали без неё.
  const flush = useCallback(async () => {
    if (!navigator.onLine || readQueue().length === 0) return;
    const { sent } = await flushQueue(async (item) => {
      const r = await sendChat(item.text, item.lessonId, true);
      setMessages(r.messages);
    });
    if (sent.length > 0) setQueued(readQueue());
  }, []);
  useEffect(() => {
    if (online) void flush();
  }, [online, flush]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, queued]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    if (!navigator.onLine) {
      setQueued(enqueue({ text: value, lessonId, at: Date.now() }));
      return;
    }
    setBusy(true);
    try {
      const r = await sendChat(value, lessonId);
      setMessages(r.messages);
    } catch {
      setQueued(enqueue({ text: value, lessonId, at: Date.now() }));
    } finally {
      setBusy(false);
    }
  };

  const empty = loaded && messages.length === 0 && queued.length === 0;

  return (
    <div className="chat">
      <div className="chat-log" role="log" aria-live="polite" aria-label={t.chatLog}>
        {!loaded && <p className="chat-empty">{t.chatLoading}</p>}
        {empty && (
          <div className="chat-empty">
            <Illustration kind="chat" size={72} />
            <p>{t.chatEmpty}</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.fromStudent ? "msg mine" : "msg"}>
            {m.text}
          </div>
        ))}
        {queued.map((q) => (
          <div key={q.at} className="msg mine pending">
            {q.text}
            <span className="msg-note">{t.queuedNote}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer t={t} value={text} busy={busy} onChange={setText} onSubmit={() => void submit()} />
    </div>
  );
}
