/**
 * Полоска состояния над списком: «Нет интернета — открываются сохранённые
 * уроки», «Показываю сохранённую копию». role=status — читалка объявит её
 * сама, когда она появится, без перехвата фокуса.
 */
export function Banner({ text, tone = "warn" }: { text: string; tone?: "warn" | "info" }) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      <span className="banner-dot" aria-hidden="true" />
      {text}
    </div>
  );
}
