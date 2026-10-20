import { useState } from "react";
import { api, ApiError } from "../api";

/**
 * ПОДКЛЮЧЕНИЕ ХРАНИЛИЩА ВИДЕО ОДНОЙ ВСТАВКОЙ.
 *
 * Ниже на странице есть четыре отдельных поля для Cloudflare — адрес, бакет,
 * ключ доступа, секретный ключ. Владелец на них застрял: «не понял что куда
 * копировать, сложно». Четыре переноса подряд с чужой англоязычной страницы —
 * это четыре шанса ошибиться, причём ошибка ничего не скажет, просто однажды
 * не загрузится урок.
 *
 * Здесь вставка ровно одна: выделить всю страницу Cloudflare, скопировать,
 * вставить сюда. Что где — разбирает сервер (storage/pasteCredentials.ts), он
 * же сразу пробует достучаться до хранилища и говорит, заработало или нет.
 *
 * Поле очищается после отправки, и введённое не показывается обратно: секретный
 * ключ Cloudflare показывает один раз, и висеть на экране открытой панели ему
 * незачем.
 */

type PasteResult = {
  ok: boolean;
  detail: string;
  found: { endpoint: boolean; accessKeyId: boolean; secretKey: boolean };
  /** Имя хранилища, которое назвало само хранилище; null — не удалось спросить. */
  bucket: string | null;
  /** Хранилищ несколько — выбрать за владельца нельзя, говорим из чего. */
  bucketNote: string | null;
};

export function StoragePaste({ onDone }: { onDone?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PasteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<PasteResult>("/admin/storage-paste", { method: "POST", body: { text } });
      setResult(res);
      setText("");
      onDone?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не получилось. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card soft" style={{ marginBottom: 18 }}>
      <h3 style={{ marginTop: 0 }}>Подключить хранилище видео — одной вставкой</h3>
      <p className="hint">
        Откройте в Cloudflare страницу с ключами R2, нажмите Ctrl+A, потом Ctrl+C — и вставьте сюда всё целиком.
        Ничего выбирать и разделять не нужно, адрес и оба ключа я найду сам.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Вставьте сюда страницу Cloudflare целиком"
        aria-label="Текст со страницы Cloudflare"
      />
      <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn" type="button" onClick={() => void submit()} disabled={busy || text.trim().length < 20}>
          {busy ? "Разбираю и проверяю…" : "Подключить"}
        </button>
        {error && <span className="check-note err">{error}</span>}
        {result && (
          <span className={`check-note ${result.ok ? "ok" : "err"}`}>
            {result.ok
              ? `Хранилище подключено${result.bucket ? ` · ${result.bucket}` : ""}`
              : `Ключи сохранены, но хранилище не отвечает: ${result.detail}`}
          </span>
        )}
        {result?.bucketNote && <span className="check-note">{result.bucketNote}</span>}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        Секретный ключ Cloudflare показывает один раз. Если та страница уже закрыта — создайте в R2 новый токен,
        старый после этого можно удалить.
      </p>
    </div>
  );
}
