import { useEffect, useRef } from "react";
import type { Dict } from "../i18n";

export type PlayerErrorKind = "network" | "media" | "unsupported";

/**
 * Оверлей ошибки поверх видео. role=alert — читалка объявит сразу; фокус на
 * «Попробовать снова», чтобы с клавиатуры и с TalkBack повтор был в одно
 * действие. «Не поддерживается» повторять бессмысленно — кнопки нет.
 */
export function ErrorOverlay({ t, kind, onRetry }: { t: Dict; kind: PlayerErrorKind; onRetry: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
  }, []);
  const text = kind === "network" ? t.playerNetwork : kind === "media" ? t.playerMedia : t.playerUnsupported;
  return (
    <div className="player-overlay" role="alert">
      <p>{text}</p>
      {kind !== "unsupported" && (
        <button ref={btn} type="button" className="btn" onClick={onRetry}>
          {t.retry}
        </button>
      )}
    </div>
  );
}
