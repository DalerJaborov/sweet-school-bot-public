import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { haptic } from "../telegram";
import { money, timeAgo } from "../format";

/**
 * КАРТОЧКА ЧЕКА ДЛЯ ОДНОГО ПАЛЬЦА (предложение «Утро Ширин» §5).
 *
 * Фото крупно, сумма и курс, которые прочитал ИИ, — чипами, ник контакта.
 * Свайп вправо — подтвердить, влево — отклонить: pointer events без
 * библиотеки, вертикальная прокрутка не ломается (touch-action: pan-y —
 * браузер отдаёт нам только горизонтальные жесты). Кнопки остаются для ПК и
 * для тех, кто свайпать не любит. Само решение (тост, отсчёт, запрос) — в
 * hooks/useReceiptDecision.ts: карточка только сообщает «подтвердить/
 * отклонить».
 */
export type ReceiptCardData = {
  id: string;
  handle: string;
  imageUrl: string | null;
  amount: number | null;
  courseGuess: string | null;
  reason?: string | null;
  confidence?: number | null;
  createdAt: string;
};

/** Дальше этого порога палец «отпустил» решение; короче — карточка вернётся. */
const SWIPE_COMMIT_PX = 96;
/** Пока горизонтальный сдвиг меньше — это ещё может быть вертикальная прокрутка. */
const SWIPE_START_PX = 10;

export function ReceiptCard(props: {
  receipt: ReceiptCardData;
  onApprove: () => void;
  onReject: () => void;
  onZoom?: (url: string) => void;
  busy?: boolean;
  /** Компактный вид для очереди на главной — миниатюра вместо фото на всю ширину. */
  compact?: boolean;
}) {
  const { receipt, onApprove, onReject, onZoom, busy = false, compact = false } = props;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const armed = useRef(false);
  /** Последний сдвиг — в ref, а не только в state: pointerup может прийти в
   *  том же кадре, что и последний move, и увидеть ещё старое значение. */
  const lastDx = useRef(0);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (busy || e.button !== 0) return;
    // Тап по кнопке/фото — не начало свайпа.
    if ((e.target as HTMLElement).closest("button, a")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    armed.current = false;
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const deltaX = e.clientX - s.x;
    const deltaY = e.clientY - s.y;
    if (!armed.current) {
      if (Math.abs(deltaX) < SWIPE_START_PX) return;
      // Палец идёт вниз, а не вбок — это прокрутка, отдаём жест браузеру.
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        start.current = null;
        return;
      }
      armed.current = true;
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // Не все браузеры/тест-окружения знают этот pointerId — свайп и без захвата работает.
      }
    }
    lastDx.current = deltaX;
    setDx(deltaX);
  }

  function finish(e: ReactPointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    const delta = lastDx.current;
    const committed = armed.current && Math.abs(delta) >= SWIPE_COMMIT_PX;
    armed.current = false;
    lastDx.current = 0;
    setDragging(false);
    if (committed) {
      haptic("rigid");
      // Карточка уезжает в сторону решения; список спрячет её по pending.
      setDx(delta > 0 ? 600 : -600);
      if (delta > 0) onApprove();
      else onReject();
      return;
    }
    setDx(0);
  }

  const direction = dx > SWIPE_START_PX ? "approve" : dx < -SWIPE_START_PX ? "reject" : "";
  const amount = receipt.amount != null ? money(receipt.amount) : null;

  return (
    <div className={`receipt-swipe ${direction}`} data-testid={`receipt-${receipt.id}`}>
      <div className="receipt-swipe-bg" aria-hidden>
        <span className="receipt-swipe-hint left">Подтвердить</span>
        <span className="receipt-swipe-hint right">Отклонить</span>
      </div>
      <div
        className={`receipt-card ${compact ? "compact" : ""} ${dragging ? "dragging" : ""}`}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dragging ? "none" : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {receipt.imageUrl ? (
          <button
            type="button"
            className="receipt-photo"
            aria-label="Открыть фото чека"
            onClick={() => onZoom?.(receipt.imageUrl as string)}
          >
            <img src={receipt.imageUrl} alt="Чек" loading="lazy" draggable={false} />
          </button>
        ) : (
          <div className="receipt-photo empty">без фото</div>
        )}
        <div className="receipt-body">
          <div className="receipt-head">
            <span className="receipt-handle">{receipt.handle}</span>
            <span className="receipt-time">{timeAgo(receipt.createdAt)}</span>
          </div>
          {amount ? <div className="receipt-amount">{amount}</div> : <div className="receipt-amount unknown">сумма не прочиталась</div>}
          <div className="list-chips">
            {receipt.courseGuess && <span className="chip chip-accent">{receipt.courseGuess}</span>}
            {receipt.confidence != null && <span className="chip">ИИ уверен на {receipt.confidence}%</span>}
          </div>
          {receipt.reason && <div className="receipt-reason">{receipt.reason}</div>}
          <div className="receipt-actions">
            <button type="button" className="btn" disabled={busy} onClick={onApprove}>
              Подтвердить
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={onReject}>
              Отклонить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
