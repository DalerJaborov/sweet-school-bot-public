import { useCallback } from "react";
import { api } from "../api";
import { chooseOption } from "../components/ChoiceSheet";
import { toast } from "../components/Toast";
import { useUndoable } from "./useUndoable";
import { haptic } from "../telegram";

/**
 * РЕШЕНИЕ ПО ЧЕКУ ОДНИМ ПАЛЬЦЕМ — общая логика для inbox чеков и очереди
 * на главной (предложение «Утро Ширин» §5, §19).
 *
 * Подтвердить: без окна «Точно?» — тост «Ссылка ушла @ника · Отменить», и
 * через 5 с уходит ТОТ ЖЕ запрос, что и раньше (POST /admin/receipts/:id/
 * decide → receiptDecision.ts, общий с кнопками в Telegram). Сумма не
 * прочиталась — лист с выбором курса (решение владельца 25.08.2026: не
 * угадывать «70 по умолчанию»). Отклонить: лист с причиной одним тапом,
 * причина уходит в журнал чека.
 */
export type CourseChoice = "COURSE50" | "COURSE70" | "BOTH";

export type ReceiptLike = {
  id: string;
  handle: string;
  amount: number | null;
};

const COURSE_OPTIONS = [
  { value: "COURSE50", label: "Арт-десерты", hint: "открыть первый курс" },
  { value: "COURSE70", label: "21 рецепт", hint: "открыть второй курс" },
  { value: "BOTH", label: "Оба курса", hint: "комплект" },
];

export const REJECT_REASONS = [
  { value: "нет суммы", label: "Нет суммы", hint: "сумма не видна или не та" },
  { value: "чужой чек", label: "Чужой чек", hint: "не наши реквизиты" },
  { value: "повтор", label: "Повтор", hint: "этот чек уже присылали" },
  { value: "другое", label: "Другое", danger: true },
];

export function useReceiptDecision(opts: { onSettled?: () => void } = {}) {
  const { onSettled } = opts;
  const { pending, schedule } = useUndoable();

  const send = useCallback(
    async (id: string, body: { action: "approve" | "reject"; course?: CourseChoice; reason?: string }) => {
      const r = await api<{ message: string }>(`/admin/receipts/${id}/decide`, { method: "POST", body });
      toast(r.message);
    },
    []
  );

  const approve = useCallback(
    async (receipt: ReceiptLike, course?: CourseChoice) => {
      let chosen = course;
      if (receipt.amount == null && !chosen) {
        const picked = await chooseOption({ title: "Сумма не прочиталась — какой курс открыть?", options: COURSE_OPTIONS });
        if (!picked) return false;
        chosen = picked as CourseChoice;
      }
      // Отдача в палец по исходу свайпа («Утро Ширин» §20): подтвердили —
      // «успех», отклонили — «внимание». Вне Telegram — ничего.
      haptic("success");
      schedule({
        key: receipt.id,
        text: `Ссылка ушла ${receipt.handle}`,
        run: () => send(receipt.id, { action: "approve", course: chosen }),
        onDone: onSettled,
        onUndo: onSettled,
      });
      return true;
    },
    [schedule, send, onSettled]
  );

  const reject = useCallback(
    async (receipt: ReceiptLike) => {
      const reason = await chooseOption({ title: "Почему отклоняем?", options: REJECT_REASONS });
      if (!reason) return false;
      haptic("warning");
      schedule({
        key: receipt.id,
        text: `Отказ ушёл ${receipt.handle}`,
        run: () => send(receipt.id, { action: "reject", reason }),
        onDone: onSettled,
        onUndo: onSettled,
      });
      return true;
    },
    [schedule, send, onSettled]
  );

  return { pending, approve, reject };
}
