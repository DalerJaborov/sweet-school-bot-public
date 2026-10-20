import { useEffect, type ReactNode } from "react";
import { Icons } from "./Brand";
import { hasTelegramWebApp, useTelegramBackButton } from "../telegram";

/**
 * ЛИСТ СНИЗУ — общий контейнер для «Ещё», выбора причины отказа и любых
 * коротких выборов на телефоне (предложение «Утро Ширин» §20). На узком
 * экране выезжает снизу под большой палец, на ПК (≥900px) — окно по центру
 * (см. .sheet в styles.css). Закрывается тапом мимо, Esc и кнопкой «Назад»
 * Telegram, если панель открыта в мини-приложении; вне Telegram — крестик в
 * углу (в мессенджере он лишний: стрелка в шапке делает то же самое).
 */
export function Sheet(props: { open: boolean; label: string; onClose: () => void; children: ReactNode }) {
  const { open, label, onClose, children } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useTelegramBackButton(open, onClose);

  if (!open) return null;
  const inTelegram = hasTelegramWebApp();
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {!inTelegram && (
          <button type="button" className="tg-sheet-close" aria-label="Закрыть" onClick={onClose}>
            {Icons.close}
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
