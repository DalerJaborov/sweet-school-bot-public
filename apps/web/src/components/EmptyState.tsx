import type { ReactNode } from "react";
import { Illustration, type Scene } from "./Illustration";

/**
 * ПУСТОЕ СОСТОЯНИЕ, КОТОРОЕ РАДУЕТ («Утро Ширин» §16): сцена + заголовок +
 * одна строка подсказки + необязательное действие. Заголовок — что случилось
 * («Всё разобрано»), подсказка — что теперь («можно спокойно пить чай»),
 * действие — только когда есть что нажать («Ещё раз» при обрыве сети).
 *
 * role="status" — читалка объявит смену состояния списка, не заставляя
 * искать, куда делись строки.
 */
export function EmptyState({
  scene,
  title,
  hint,
  action,
  size = 120,
  children,
}: {
  scene: Scene;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; busy?: boolean };
  size?: number;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status" data-testid={`empty-${scene}`}>
      <Illustration scene={scene} size={size} />
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {action && (
        <button type="button" className="btn ghost small" disabled={action.busy} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}

/** Ошибка сети одной строкой — сцена Offline и кнопка «Ещё раз». */
export function OfflineState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <EmptyState scene="Offline" title="Сеть не ответила" hint={humanNetworkError(error)} action={{ label: "Ещё раз", onClick: onRetry }} />;
}

/** «Failed to fetch» / «NetworkError» браузера — по-русски и по-человечески;
 *  всё остальное (текст ошибки сервера) — как есть. */
export function humanNetworkError(error: string): string {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(error)
    ? "Похоже, нет связи. Проверьте интернет — и попробуйте ещё раз."
    : error;
}
