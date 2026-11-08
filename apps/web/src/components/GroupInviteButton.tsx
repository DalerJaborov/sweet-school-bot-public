import { useRef, useState } from "react";
import { api } from "../api";

/**
 * «Ссылка в группу» рядом с выдачей доступа. Платёжный путь не трогает: только
 * выпускает приглашение в Telegram-группу курса на ОДИН вход (раздел «Ссылки»,
 * POST /admin/v1/links/telegram) и показывает его для пересылки. Вход по нему
 * связывает Telegram ученицы с её карточкой.
 */
export function GroupInviteButton({
  course,
  title,
  contactId,
  name,
}: {
  course: string;
  title: string;
  contactId: string;
  name: string;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);

  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ invite: { link: string } }>("/admin/v1/links/telegram", {
        method: "POST",
        body: { group: course, preset: "one", name: name.trim().slice(0, 32) || null, contactId },
      });
      setLink(d.invite.link);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось создать ссылку в группу");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (link)
    return (
      <div className="field">
        <span>Ссылка в Telegram-группу «{title}» — на один вход</span>
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={`Ссылка в группу ${title}`}
        />
        <button
          type="button"
          className="btn ghost small"
          style={{ marginTop: 8 }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setError("Не удалось скопировать. Выделите ссылку и скопируйте вручную.");
            }
          }}
        >
          {copied ? "Скопировано" : "Скопировать ссылку в группу"}
        </button>
      </div>
    );
  return (
    <div>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void create()}>
        {busy ? "Создаю…" : `Ссылка в группу «${title}»`}
      </button>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
