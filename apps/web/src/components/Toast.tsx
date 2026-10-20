import { useEffect, useState } from "react";

/**
 * ВСПЛЫВАЮЩЕЕ УВЕДОМЛЕНИЕ ОБ УСПЕХЕ.
 *
 * Раньше «Сохранено» вставлялось прямо в поток карточки, над полями. Как только
 * оно появлялось, все поля под ним съезжали вниз на высоту полоски — форма
 * дёргалась в момент, когда человек только что нажал «Сохранить» и продолжает
 * смотреть на экран. Владелец описал это как «перескакивает» — и был прав: то
 * же самое повторялось на Воронках и Стиле, везде с одинаковым кодом.
 *
 * Тост стоит ПОВЕРХ страницы (position: fixed), поэтому его появление и исчезание
 * не двигает ни один элемент формы, и сам гаснет — не нужно нажимать «закрыть».
 * Ошибки этот компонент не заменяет: их пользователь должен УВИДЕТЬ и прочитать,
 * поэтому они остаются на месте — постоянной строкой в карточке.
 *
 * ТОСТ С «ОТМЕНИТЬ» (05.09.2026, предложение «Утро Ширин» §19). Вместо окна
 * «Точно подтвердить?» действие выполняется само через несколько секунд, а в
 * тосте есть кнопка отмены — один тап вместо трёх, и ошибку всё ещё можно
 * поймать. Само откладывание делает вызывающий (см. hooks/useUndoable.ts);
 * тост только показывает кнопку и зовёт `action.onClick`.
 */

let counter = 0;
type ToastVariant = "success" | "error";
type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; text: string; variant: ToastVariant; action?: ToastAction };
export type ToastOptions = { variant?: ToastVariant; duration?: number; action?: ToastAction };

const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const l of listeners) l([...items]);
}

/** Убрать тост раньше срока — например, когда человек нажал «Отменить». */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (!items.some((i) => i.id === id)) return;
  items = items.filter((i) => i.id !== id);
  emit();
}

/**
 * Всплывающее уведомление. Вторым аргументом — либо вариант («error»: красная
 * полоска, держится дольше, 4 сек), либо объект с действием и своей
 * длительностью. Возвращает id, чтобы убрать тост раньше срока.
 */
export function toast(text: string, options: ToastVariant | ToastOptions = "success"): number {
  const opts: ToastOptions = typeof options === "string" ? { variant: options } : options;
  const variant = opts.variant ?? "success";
  const duration = opts.duration ?? (variant === "error" ? 4000 : 2600);
  const id = ++counter;
  items = [...items, { id, text, variant, action: opts.action }];
  emit();
  timers.set(id, setTimeout(() => dismissToast(id), duration));
  return id;
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (list.length === 0) return null;
  return (
    // aria-live: «Настройки сохранены» и ошибки должны озвучиваться экранным
    // диктором, а не только мелькать четыре секунды в углу.
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((i) => (
        <div
          className={`toast ${i.variant === "error" ? "toast-error" : ""} ${i.action ? "toast-action" : ""}`}
          role={i.variant === "error" ? "alert" : undefined}
          key={i.id}
        >
          <span>{i.text}</span>
          {i.action && (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                dismissToast(i.id);
                i.action?.onClick();
              }}
            >
              {i.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
