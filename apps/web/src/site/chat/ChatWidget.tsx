import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Dict, Lang } from "../i18n";
import { api, ApiError, type ChatMsg } from "../api";
import { linkify } from "./linkify";
import { chatStrings } from "./strings";
import "./chat.css";

/**
 * Окно чата с ботом-продавцом (тот же ИИ, что в Instagram).
 *
 * Поток: start → история; send отвечает МГНОВЕННО своим эхом (`pending:true`),
 * ответ ИИ прилетает фоном через /poll. Пока идёт генерация — опрос каждую
 * секунду (до 40 с), потом раз в 4 с (до минуты), потом раз в 15 с — «в покое»,
 * когда ответы Ширин из Telegram всё ещё могут доехать сюда же.
 *
 * Доступность: role=dialog + aria-modal, фокус заперт внутри, Esc закрывает,
 * лента — aria-live, чтобы читалка озвучила ответ.
 */

const POLL_FAST_MS = 1000;
const POLL_FAST_WINDOW_MS = 40_000;
const POLL_MID_MS = 4000;
const POLL_MID_WINDOW_MS = 60_000;
const POLL_IDLE_MS = 15000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const NEAR_BOTTOM_PX = 48;
const LAST_SEEN_KEY = "ssb_chat_last_seen";

type ChatBatchExt = { messages: ChatMsg[]; pending?: boolean; typing?: boolean };
type LocalMsg = ChatMsg & { optimistic?: boolean; sent?: boolean };

type Props = { t: Dict; lang: Lang; prefill?: string; onClose: () => void };

function nextPollDelay(typingSinceMs: number | null): number {
  if (typingSinceMs === null) return POLL_IDLE_MS;
  const elapsed = Date.now() - typingSinceMs;
  if (elapsed < POLL_FAST_WINDOW_MS) return POLL_FAST_MS;
  if (elapsed < POLL_FAST_WINDOW_MS + POLL_MID_WINDOW_MS) return POLL_MID_MS;
  return POLL_IDLE_MS;
}

export default function ChatWidget({ t, lang, prefill, onClose }: Props) {
  const strings = chatStrings(lang);
  const [messages, setMessages] = useState<LocalMsg[]>([]);
  const [ready, setReady] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [text, setText] = useState(prefill ?? "");
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastIdRef = useRef<string | null>(null);
  const typingSinceRef = useRef<number | null>(null);
  const wasEmptyRef = useRef(true);
  const typingRef = useRef(false);
  useEffect(() => {
    typingRef.current = typing;
  }, [typing]);

  const append = useCallback((batch: ChatMsg[]) => {
    if (batch.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.filter((m) => !m.optimistic).map((m) => m.id));
      const fresh = batch.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return prev;
      // Реальный ответ сервера сменяет оптимистичный «черновик» того же автора.
      const withoutOptimistic = prev.filter((m) => !m.optimistic);
      return [...withoutOptimistic, ...fresh];
    });
    lastIdRef.current = batch[batch.length - 1].id;
    try {
      localStorage.setItem(LAST_SEEN_KEY, lastIdRef.current);
    } catch {
      /* ignore */
    }
  }, []);

  // Старт: история + кука посетителя.
  useEffect(() => {
    let alive = true;
    api.chatStart(lang).then(
      (r) => {
        if (!alive) return;
        wasEmptyRef.current = r.messages.length === 0;
        append(r.messages);
        setReady(true);
      },
      () => alive && setStartError(t.chatStartFailed),
    );
    return () => {
      alive = false;
    };
  }, [lang, append, t.chatStartFailed]);

  // Опрос: адаптивный — быстрый, пока ждём ответ ИИ, реже по мере ожидания,
  // редкий в покое. Только на видимой вкладке.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") {
        try {
          const r = (await api.chatPoll(lastIdRef.current)) as ChatBatchExt;
          if (!alive) return;
          if (r.messages.length > 0) append(r.messages);
          // Сервер может не прислать `typing` (старые сборки/моки) — тогда
          // держим индикатор, пока не увидим не-своё сообщение.
          const hasReply = r.messages.some((m) => m.from !== "client");
          const stillTyping = r.typing !== undefined ? r.typing : typingRef.current && !hasReply;
          setTyping(stillTyping);
          if (!stillTyping) {
            setPending(false);
            typingSinceRef.current = null;
          }
        } catch {
          /* сеть моргнула — следующий тик */
        }
      }
      if (alive) timer = setTimeout(tick, nextPollDelay(typingSinceRef.current));
    };
    timer = setTimeout(tick, nextPollDelay(typingSinceRef.current));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready, pending, append]);

  // Прокрутка к последнему сообщению — только если человек и так был внизу
  // (не выдёргиваем его, если он читает историю выше).
  const stickToBottomRef = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [ready]);

  // Фокус в поле при открытии; ловушка фокуса; Esc. Контракт со sticky-баром:
  // пока чат открыт, документ несёт data-chat-open="1".
  useEffect(() => {
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    if (window.matchMedia?.("(max-width: 719px)").matches) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // iOS: клавиатура сдвигает visualViewport, а не меняет размер окна —
  // держим панель (и поле ввода) над клавиатурой через ту же метрику.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !panelRef.current) return;
    const onResize = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panelRef.current!.style.setProperty("--kb-offset", `${offset}px`);
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], textarea, input:not([type="file"]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const pickImage = (file: File | null) => {
    setError(null);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
      setError(t.imageBadType);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t.imageTooBig);
      return;
    }
    setImage(file);
  };

  const send = async (e?: FormEvent, override?: string) => {
    e?.preventDefault();
    const body = (override ?? text).trim();
    if (sending || (!body && !image)) return;
    setSending(true);
    setError(null);

    // Оптимистичное эхо — своё сообщение появляется мгновенно, ещё до ответа
    // сервера; галочка «доставлено» — когда сервер его подтвердит.
    const optimisticId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stickToBottomRef.current = true;
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, from: "client", text: body || null, imageUrl: imageUrl, at: new Date().toISOString(), optimistic: true },
    ]);

    try {
      const r = (await api.chatSend(body, image)) as ChatBatchExt;
      append(r.messages);
      const isPending = Boolean(r.pending);
      setPending(isPending);
      if (isPending) typingSinceRef.current = Date.now();
      setTyping(isPending);
      setText("");
      setImage(null);
      inputRef.current?.focus();
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      if (err instanceof ApiError && err.status === 429) setError(t.chatRateLimited(err.retryAfterSec ?? 600));
      else setError(t.chatSendFailed);
    } finally {
      setSending(false);
    }
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const sendQuickReply = (label: string) => {
    void send(undefined, label);
  };

  const canSend = ready && !sending && (text.trim().length > 0 || image !== null);
  const showGreeting = ready && messages.length === 0 && !pending && wasEmptyRef.current;

  return (
    <>
      <div className="chat-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="chat-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssb-chat-title"
        onKeyDown={onKeyDown}
      >
        <header className="chat-head">
          <span className="avatar" aria-hidden="true">
            S
          </span>
          <div>
            <h2 id="ssb-chat-title">{t.chatTitle}</h2>
            <p>{t.chatSubtitle}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t.close}>
            <CloseGlyph />
          </button>
        </header>

        <div ref={logRef} className="chat-log" role="log" aria-live="polite" aria-label={t.chatLog}>
          {startError && (
            <p className="chat-err" role="alert">
              {startError}
            </p>
          )}
          {showGreeting && (
            <div className="msg msg-bot msg-greeting" data-from="bot">
              <span>{strings.greeting}</span>
            </div>
          )}
          {showGreeting && (
            <div className="quick-replies">
              {strings.quickReplies.map((label) => (
                <button key={label} type="button" className="quick-reply" onClick={() => sendQuickReply(label)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} t={t} strings={strings} />
          ))}
          {typing && (
            <div className="typing" role="status" aria-label={t.chatTyping}>
              <i />
              <i />
              <i />
            </div>
          )}
        </div>

        {error && (
          <p className="chat-err" role="alert">
            {error}
          </p>
        )}
        {image && (
          <div className="attach-preview">
            {imageUrl && <img src={imageUrl} alt={t.attachedImageAlt} width={48} height={48} />}
            <span>{image.name}</span>
            {sending && (
              <span className="uploading" role="status">
                {strings.uploading}
              </span>
            )}
            <button type="button" onClick={() => setImage(null)} disabled={sending}>
              {t.removeImage}
            </button>
          </div>
        )}

        <form className="composer" onSubmit={send}>
          <label className="icon-btn" aria-label={t.attachImage} title={t.attachImage}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="visually-hidden"
              onChange={(e) => {
                pickImage(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              disabled={!ready}
            />
            <ClipGlyph />
          </label>
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            maxLength={2000}
            placeholder={image ? strings.uploadPlaceholder : t.chatPlaceholder}
            aria-label={t.chatInputLabel}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onComposerKey}
            disabled={!ready && !startError}
            enterKeyHint="send"
          />
          <button type="submit" className="icon-btn send" disabled={!canSend} aria-label={t.send}>
            {sending ? <span aria-hidden="true">…</span> : <SendGlyph />}
          </button>
        </form>
      </div>
    </>
  );
}

function Message({ m, t, strings }: { m: LocalMsg; t: Dict; strings: ReturnType<typeof chatStrings> }) {
  const who = m.from === "client" ? t.fromYou : m.from === "owner" ? t.fromOwner : t.fromBot;
  const at = new Date(m.at);
  const [showTime, setShowTime] = useState(false);
  return (
    <div
      className={`msg msg-${m.from}${m.optimistic ? " msg-pending" : ""}`}
      data-from={m.from}
      onMouseEnter={() => setShowTime(true)}
      onMouseLeave={() => setShowTime(false)}
      onTouchStart={() => setShowTime(true)}
      onTouchEnd={() => setTimeout(() => setShowTime(false), 1500)}
    >
      {m.from === "owner" && <span className="msg-label">{t.fromOwner}</span>}
      <span className="visually-hidden">{who}: </span>
      {m.text && <MessageText text={m.text} t={t} />}
      {m.imageUrl && <img src={m.imageUrl} alt={t.attachedImageAlt} loading="lazy" width={240} height={240} />}
      <span className="msg-meta">
        {!Number.isNaN(at.getTime()) && (
          <time dateTime={m.at} className={showTime ? "shown" : undefined}>
            {t.messageTime(at)}
          </time>
        )}
        {m.from === "client" && !m.optimistic && (
          <span className="msg-sent" aria-label={strings.sent} title={strings.sent}>
            ✓
          </span>
        )}
      </span>
    </div>
  );
}

function MessageText({ text, t }: { text: string; t: Dict }) {
  const parts = linkify(text);
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.value}</span>
        ) : p.platform ? (
          <a key={i} className="msg-link" href={p.href}>
            🎓 {t.openLessonsLink}
          </a>
        ) : (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.label}
          </a>
        ),
      )}
    </>
  );
}

function CloseGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M2 11 20 3l-5 16-4-6z" fill="currentColor" />
    </svg>
  );
}
function ClipGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.5 1.5 0 0 1-2.1-2.1l8.3-8.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
