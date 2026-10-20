import { useEffect } from "react";
import { confirmDialog } from "./ConfirmDialog";

/**
 * ЗАЩИТА ОТ ПОТЕРИ ВВОДА ПРИ УХОДЕ С ЭКРАНА.
 *
 * Воронки и Настройки — длинные формы: промт ИИ занимает десять тысяч символов,
 * редактор шагов воронки — десяток полей. Один случайный тап по нижней навигации
 * посреди правки раньше стирал всё без единого предупреждения — форма просто
 * размонтировалась. Хук ставит подтверждение браузера, а App.tsx перед сменой
 * вкладки спрашивает через тот же module-level флаг.
 */

let dirty = false;

export function isDirty(): boolean {
  return dirty;
}

/** Вызвать перед тем, как сменить вкладку/выйти — покажет «уверены?», если есть
 *  несохранённое. true — можно продолжать (либо ничего не менялось, либо
 *  человек подтвердил уход и потерю правок). */
export async function confirmLeave(): Promise<boolean> {
  if (!dirty) return true;
  return confirmDialog({
    title: "Есть несохранённые изменения",
    message: "Уйти и потерять их?",
    confirmLabel: "Уйти",
    cancelLabel: "Остаться",
    danger: true,
  });
}

/** Отмечает текущий экран как имеющий несохранённые правки, пока он смонтирован.
 *  `active` — включать проверку только пока реально есть что терять (например,
 *  пока открыт редактор воронки, а не список). */
export function useUnsavedGuard(active: boolean): void {
  useEffect(() => {
    dirty = active;
    return () => {
      dirty = false;
    };
  }, [active]);

  // Закрытие вкладки браузера/Telegram — стандартное предупреждение ОС.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
