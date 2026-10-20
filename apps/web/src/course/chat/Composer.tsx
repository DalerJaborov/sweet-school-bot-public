import { useLayoutEffect, useRef, type FormEvent } from "react";
import type { Dict } from "../i18n";

/**
 * Поле вопроса. Textarea с автовысотой (до 5 строк): рецептурные вопросы
 * длинные, а однострочное поле прятало начало. Шрифт 16px — иначе Safari на
 * iPhone приближает страницу при фокусе. Enter — перенос строки, отправка —
 * кнопкой: на телефоне так привычнее, и случайно не улетит половина фразы.
 */
export function Composer({
  t,
  value,
  busy,
  onChange,
  onSubmit,
}: {
  t: Dict;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 5 * 24 + 24)}px`;
  }, [value]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        maxLength={1000}
        placeholder={t.chatPlaceholder}
        aria-label={t.chatInputLabel}
        onChange={(e) => onChange(e.target.value)}
        enterKeyHint="enter"
      />
      <button type="submit" className="btn composer-send" disabled={busy || !value.trim()} aria-label={t.send}>
        {busy ? "…" : <SendGlyph />}
      </button>
    </form>
  );
}

function SendGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M2 11 20 3l-5 16-4-6z" fill="currentColor" />
    </svg>
  );
}
