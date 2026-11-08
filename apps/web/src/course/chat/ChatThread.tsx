import { useCallback, useEffect, useRef, useState } from "react";
import { loadChat, sendChat, type ChatMessage } from "../api";
import type { Dict } from "../i18n";
import { Illustration } from "../components/Illustration";
import { Composer } from "./Composer";
import { enqueue, flushQueue, readQueue, type QueuedChat } from "./queue";
import { isPreview } from "../preview";

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
  // Предпросмотр владельца: ни ленты, ни поля. Иначе неотправленный вопрос лёг
  // бы в очередь телефона и ушёл бы позже как вопрос настоящей ученицы.
  if (isPreview()) {
    return (
      <div className="chat">
        <div className="chat-empty" role="status">
          <Illustration kind="chat" size={72} />
          <p>{t.previewChatOff}</p>
        </div>
      </div>
    );
  }
  return <LiveChatThread t={t} lessonId={lessonId} online={online} />;
}

function LiveChatThread({ t, lessonId, online }: { t: Dict; lessonId: string | null; online: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [queued, setQueued] = useState<QueuedChat[]>(() => readQueue());
  const bottomRef = useRef<HTMLDivElement>(null);

  const mounted = useRef(true);
  const requestTail = useRef<Promise<unknown>>(Promise.resolve());
  const flushing = useRef(false);
  // Reads and writes share one sequence. A slow history response cannot replace
  // the result of a newer question, and offline questions retain their order.
  const serial = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = requestTail.current.then(task);
    requestTail.current = next.catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visibleOnline = () => online && navigator.onLine && document.visibilityState === "visible";
    const poll = async () => {
      if (cancelled || polling || !visibleOnline()) return;
      polling = true;
      try {
        const result = await serial(() => cancelled || !visibleOnline() ? Promise.resolve(null) : loadChat());
        if (!cancelled && result) {
          setMessages(result.messages);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) { setLoadFailed(true); setLoaded(true); }
      } finally {
        polling = false;
        if (!cancelled && visibleOnline()) timer = setTimeout(() => void poll(), 8000);
      }
    };
    const resume = () => {
      if (timer) clearTimeout(timer);
      if (visibleOnline()) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [online, serial]);

  // Появилась сеть — досылаем то, что писали без неё.
  const flush = useCallback(async () => {
    if (!navigator.onLine || flushing.current || readQueue().length === 0) return;
    flushing.current = true;
    const { sent } = await flushQueue(async (item) => {
      const r = await serial(() => sendChat(item.text, item.lessonId, true));
      if (mounted.current) { setMessages(r.messages); setLoadFailed(false); setLoaded(true); }
    });
    flushing.current = false;
    if (mounted.current && sent.length > 0) setQueued(readQueue());
  }, [serial]);
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
    if (!online || !navigator.onLine || flushing.current || readQueue().length > 0) {
      setQueued(enqueue({ text: value, lessonId, at: Date.now() }));
      if (online) void flush();
      return;
    }
    setBusy(true);
    try {
      const r = await serial(() => sendChat(value, lessonId));
      if (mounted.current) { setMessages(r.messages); setLoadFailed(false); setLoaded(true); }
    } catch {
      const pending = enqueue({ text: value, lessonId, at: Date.now() });
      if (mounted.current) setQueued(pending);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const empty = loaded && !loadFailed && messages.length === 0 && queued.length === 0;
  const awaitingAnswer = messages.at(-1)?.fromStudent === true;

  return (
    <div className="chat">
      <div className="chat-log" role="log" aria-live="polite" aria-label={t.chatLog}>
        {!loaded && <p className="chat-empty">{t.chatLoading}</p>}
        {loadFailed && <p role="status" className="chat-empty">{t.chatLoadFailed}</p>}
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
        {awaitingAnswer && <p role="status" className="msg-note">{t.questionSaved}</p>}
        <div ref={bottomRef} />
      </div>
      <Composer t={t} value={text} busy={busy} onChange={setText} onSubmit={() => void submit()} />
    </div>
  );
}
