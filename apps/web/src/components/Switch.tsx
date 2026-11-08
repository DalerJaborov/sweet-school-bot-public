import type { ReactNode } from "react";

/**
 * ТУМБЛЕР «ВКЛ / ВЫКЛ» — большая цель под палец (≥48px по высоте), подпись слева,
 * переключатель справа. Это настоящий checkbox с role="switch": клавиатура и
 * читалки с экрана понимают его как выключатель.
 *
 * Сам тумблер ничего не сохраняет: вызывающий меняет своё состояние сразу
 * (оптимистично) и при сбое откатывает. Тумблер НЕ блокируем на время
 * сохранения — соседние и он сам остаются живыми.
 */
export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const { checked, onChange, label, hint, disabled, testId } = props;
  return (
    <label className={`switch-row${disabled ? " disabled" : ""}`}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}
