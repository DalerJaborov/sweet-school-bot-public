import { useCallback, useEffect, useRef, useState } from "react";
import { toast, dismissToast } from "../components/Toast";
import { haptic } from "../telegram";

/**
 * ОТЛОЖЕННОЕ ДЕЙСТВИЕ С «ОТМЕНИТЬ» (предложение «Утро Ширин» §19, 05.09.2026).
 *
 * Вместо окна «Точно?» действие выполняется само через `delayMs` (5 с), а в
 * тосте есть кнопка «Отменить». Это НЕ откат в базе: пока идёт отсчёт,
 * сервер ещё ничего не знает, и «Отменить» просто гасит таймер. Так один тап
 * заменяет три, а ошибку по-прежнему можно поймать — но сама операция на
 * сервере остаётся ровно той же (receiptDecision.ts), без новых путей отката.
 *
 * `pending` — что сейчас в отсчёте: список прячет такие карточки сразу
 * (оптимистично), а по «Отменить» возвращает. Ключ — любой id строки.
 */
export const UNDO_DELAY_MS = 5000;

type Scheduled = { key: string; timer: ReturnType<typeof setTimeout>; toastId: number };

export function useUndoable(delayMs = UNDO_DELAY_MS) {
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const scheduled = useRef(new Map<string, Scheduled>());

  // Уход со страницы посреди отсчёта: действие обязано выполниться, а не
  // потеряться молча — человек нажал «Подтвердить» и считает дело сделанным.
  // Поэтому таймеры НЕ чистим при размонтировании; чистим только тосты.
  useEffect(() => {
    const map = scheduled.current;
    return () => {
      for (const s of map.values()) dismissToast(s.toastId);
    };
  }, []);

  const forget = useCallback((key: string) => {
    scheduled.current.delete(key);
    setPending((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /**
   * Запланировать. `run` выполняется по истечении отсчёта; `onUndo` — если
   * человек нажал «Отменить»; `onDone` — после успешного `run`.
   */
  const schedule = useCallback(
    (opts: { key: string; text: string; run: () => Promise<void>; onUndo?: () => void; onDone?: () => void }) => {
      const { key, text, run, onUndo, onDone } = opts;
      // Повторный тап по той же карточке — перезапускаем отсчёт, не дублируем.
      const existing = scheduled.current.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        dismissToast(existing.toastId);
      }
      const timer = setTimeout(() => {
        const s = scheduled.current.get(key);
        if (s) dismissToast(s.toastId);
        run()
          .then(() => onDone?.())
          .catch((e) => {
            toast(e instanceof Error ? e.message : "Не получилось", "error");
            haptic("error");
            onUndo?.();
          })
          .finally(() => forget(key));
      }, delayMs);
      const toastId = toast(text, {
        duration: delayMs,
        action: {
          label: `Отменить`,
          onClick: () => {
            const s = scheduled.current.get(key);
            if (s) clearTimeout(s.timer);
            forget(key);
            haptic("light");
            onUndo?.();
          },
        },
      });
      scheduled.current.set(key, { key, timer, toastId });
      setPending((prev) => new Set(prev).add(key));
    },
    [delayMs, forget]
  );

  return { pending, schedule };
}
