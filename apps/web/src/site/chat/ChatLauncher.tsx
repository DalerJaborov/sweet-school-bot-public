import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Dict, Lang } from "../i18n";
import { onChatOpen } from "./bus";
import { api } from "../api";

const OPEN_KEY = "ssb_chat_open";
const LAST_SEEN_KEY = "ssb_chat_last_seen";
/** Пока чат закрыт, изредка проверяем — не пришёл ли ответ, чтобы показать
 *  бейдж на кнопке. Не так дорого, как чат открытым, но и не мгновенно. */
const CLOSED_POLL_MS = 20_000;

/**
 * Плавающая кнопка «Спросить / Купить». Сам виджет — отдельный ленивый чанк:
 * большинство посетителей до чата не доходят, и грузить его вместе с
 * главной значило бы платить за него всем. Открытое состояние помним в
 * localStorage, чтобы после перехода на другую страницу чат остался.
 *
 * Контракт со sticky-баром (owned by another agent): пока чат открыт,
 * document.documentElement.dataset.chatOpen === "1"; закрыт — атрибута нет.
 */
const ChatWidget = lazy(() => import("./ChatWidget"));

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOpen(v: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}
function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function ChatLauncher({ t, lang }: { t: Dict; lang: Lang }) {
  const [open, setOpen] = useState(readOpen);
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const [unread, setUnread] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  // Контракт с sticky-баром.
  useEffect(() => {
    if (open) document.documentElement.dataset.chatOpen = "1";
    else delete document.documentElement.dataset.chatOpen;
    return () => {
      delete document.documentElement.dataset.chatOpen;
    };
  }, [open]);

  useEffect(
    () =>
      onChatOpen(({ prefill }) => {
        setPrefill(prefill);
        setOpen(true);
        writeOpen(true);
      }),
    [],
  );

  // Пока чат закрыт — тихо проверяем, не прилетел ли ответ, для бейджа.
  useEffect(() => {
    if (open) {
      setUnread(false);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.chatPoll(readLastSeen());
        if (!alive) return;
        if (r.messages.some((m) => m.from !== "client")) setUnread(true);
      } catch {
        /* тихо, попробуем в следующий раз */
      }
    };
    const id = setInterval(tick, CLOSED_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setPrefill(undefined);
    writeOpen(false);
    requestAnimationFrame(() => fabRef.current?.focus());
  }, []);

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="chat-fab"
        hidden={open}
        aria-label={t.chatFabAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          writeOpen(true);
        }}
      >
        <ChatGlyph />
        <span className="chat-fab-label">{t.chatFab}</span>
        {unread && (
          <span
            className="chat-fab-badge"
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#c9376b",
              border: "2px solid #fff",
            }}
          />
        )}
      </button>
      {open && (
        <Suspense fallback={null}>
          <ChatWidget t={t} lang={lang} prefill={prefill} onClose={close} />
        </Suspense>
      )}
    </>
  );
}

function ChatGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="currentColor"
      />
    </svg>
  );
}
