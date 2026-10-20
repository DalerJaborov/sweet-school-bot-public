import { useEffect, useRef, useState } from "react";

/**
 * ПОДТВЕРЖДЕНИЕ ОПАСНОГО ДЕЙСТВИЯ вместо window.confirm.
 *
 * window.confirm блокировал поток, выглядел чужеродно внутри Telegram
 * (системное окно поверх мини-приложения, без нашего оформления) и не давал
 * назвать кнопку по делу — всегда «ОК/Отмена», хотя речь про «Отобрать
 * доступ». Здесь тот же вызов-обещание, что и раньше — `await confirmDialog(...)`
 * — но окно своё: заголовок, объяснение последствий, кнопка с настоящим
 * названием действия и красным цветом для необратимого.
 *
 * Механика та же, что у Toast: очередь запросов на уровне модуля, один
 * `<ConfirmHost />` в App рисует текущий. Показывается по одному: пока
 * человек не ответил, следующие ждут — два вопроса разом не бывают нужны.
 *
 * ЗДЕСЬ ЖЕ ЗАМЕНА window.prompt — по той же причине, только хуже. Внутри
 * Telegram системный prompt не просто выглядит чужеродно: клиенты Telegram его
 * ПОДАВЛЯЮТ, и кнопка молча не делает ничего. А панель штатно открывается
 * мини-приложением Telegram — то есть «+ Раздел» и «+ Урок» у владелицы не
 * работали вовсе, и завести курс она физически не могла (найдено разбором
 * 03.09.2026). Отсюда promptDialog: то же окно, но с полем ввода.
 */

export type ConfirmOptions = {
  title: string;
  /** Что случится, если подтвердить — человек должен понять последствия. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Необратимое действие — красная кнопка. */
  danger?: boolean;
};

export type PromptOptions = ConfirmOptions & {
  placeholder?: string;
  /** Что уже вписано, когда окно открылось. */
  initial?: string;
};

/** Ответ окна: подтверждение — да/нет, ввод — строка или отказ. */
type Answer = boolean | string | null;

type Request = PromptOptions & {
  id: number;
  /** Окно с полем ввода: у него другая кнопка и другой ответ. */
  withInput: boolean;
  resolve: (value: Answer) => void;
};

let counter = 0;
let queue: Request[] = [];
const listeners = new Set<(current: Request | null) => void>();

function emit() {
  const current = queue[0] ?? null;
  for (const l of listeners) l(current);
}

/** Спросить подтверждение. true — человек нажал кнопку действия. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<Answer>((resolve) => {
    queue = [...queue, { ...options, id: ++counter, withInput: false, resolve }];
    emit();
  }).then((v) => v === true);
}

/**
 * Спросить строку. null — человек отказался или оставил поле пустым: пустое
 * название раздела бессмысленно, и считать его отказом честнее, чем заводить
 * «Раздел без имени».
 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<Answer>((resolve) => {
    queue = [...queue, { ...options, id: ++counter, withInput: true, resolve }];
    emit();
  }).then((v) => (typeof v === "string" && v.trim() ? v.trim() : null));
}

function settle(id: number, ok: Answer) {
  const req = queue.find((r) => r.id === id);
  if (!req) return;
  queue = queue.filter((r) => r.id !== id);
  req.resolve(ok);
  emit();
}

export function ConfirmHost() {
  const [current, setCurrent] = useState<Request | null>(queue[0] ?? null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  // Esc = «Отмена», как у любого диалога. Фокус — на безопасную кнопку: случайный
  // Enter не должен отобрать у человека доступ. Исключение — окно с полем
  // ввода: там опасного действия нет, и фокус нужен в поле, иначе на телефоне
  // придётся отдельно тыкать в него пальцем.
  useEffect(() => {
    if (!current) return;
    setDraft(current.withInput ? (current.initial ?? "") : "");
    if (current.withInput) inputRef.current?.focus();
    else cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(current.id, current.withInput ? null : false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;
  const titleId = `confirm-title-${current.id}`;
  const msgId = `confirm-msg-${current.id}`;

  return (
    <div className="sheet-overlay" onClick={() => settle(current.id, current.withInput ? null : false)}>
      <div
        className="dialog"
        role={current.withInput ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={current.message ? msgId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="dialog-title">
          {current.title}
        </h3>
        {current.message && (
          <p id={msgId} className="dialog-message">
            {current.message}
          </p>
        )}
        {current.withInput && (
          <input
            ref={inputRef}
            className="dialog-input"
            value={draft}
            placeholder={current.placeholder}
            aria-label={current.title}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            // Enter — самый быстрый путь на телефоне: клавиатура уже открыта,
            // тянуться к кнопке не нужно.
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) settle(current.id, draft);
            }}
          />
        )}
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn quiet"
            onClick={() => settle(current.id, current.withInput ? null : false)}
          >
            {current.cancelLabel ?? "Отмена"}
          </button>
          <button
            type="button"
            className={`btn ${current.danger ? "danger" : ""}`}
            disabled={current.withInput && !draft.trim()}
            onClick={() => settle(current.id, current.withInput ? draft : true)}
          >
            {current.confirmLabel ?? "Подтвердить"}
          </button>
        </div>
      </div>
    </div>
  );
}
