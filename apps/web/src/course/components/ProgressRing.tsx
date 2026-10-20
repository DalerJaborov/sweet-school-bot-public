/**
 * Кольцо прогресса в строке урока. Декоративное: цифры и слова («пройден»,
 * «остановились на 40%») уже есть в тексте строки и в aria-label кнопки,
 * поэтому кольцо скрыто от читалок — иначе VoiceOver читал бы прогресс дважды.
 */
export function ProgressRing({ percent, completed, size = 28 }: { percent: number; completed: boolean; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = completed ? 100 : Math.max(0, Math.min(100, percent));
  return (
    <svg
      className={completed ? "ring ring-done" : "ring"}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="ring-value"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {completed && (
        <path
          className="ring-check"
          d={`M${size * 0.3} ${size * 0.52} l${size * 0.13} ${size * 0.13} l${size * 0.27} -${size * 0.3}`}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
