import { useState } from "react";
import { api, ApiError } from "../api";

/**
 * ПОДКЛЮЧИТЬ ВЕБХУК TELEGRAM.
 *
 * Разбор безопасности 03.09.2026 показал, что адрес, по которому Telegram
 * приносит нам сообщения, был открыт всему интернету: проверка секрета в коде
 * была, а задать сам секрет было нечем. Кто угодно мог прислать выдуманное
 * «сообщение от Ширин» и записать его ученице как ответ учительницы.
 *
 * Дверь уже закрыта с другой стороны — принимаются только наши собственные
 * чаты. Эта кнопка добавляет второй замок: сервер придумывает секрет сам и тут
 * же передаёт его Telegram. Владельцу вводить нечего, ошибиться негде.
 */
export function TelegramWebhook() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const connect = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api("/admin/telegram/setup", { method: "POST" });
      setNote({ ok: true, text: "Вебхук подключён, секрет установлен" });
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : "Не получилось" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card soft" style={{ marginBottom: 18 }}>
      <h3 style={{ marginTop: 0 }}>Защитить связь с Telegram</h3>
      <p className="hint">
        Нажмите один раз после того, как впишете токен бота. Сервер сам придумает секретное слово и передаст его
        Telegram — после этого чужие сообщения к нам не пройдут. Нажимать можно сколько угодно раз.
      </p>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" type="button" onClick={() => void connect()} disabled={busy}>
          {busy ? "Подключаю…" : "Подключить вебхук"}
        </button>
        {note && <span className={`check-note ${note.ok ? "ok" : "err"}`}>{note.text}</span>}
      </div>
    </div>
  );
}
