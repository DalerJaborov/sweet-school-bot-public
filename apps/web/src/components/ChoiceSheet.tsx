import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";

/**
 * ВЫБОР ОДНИМ ТАПОМ — чипы в листе снизу вместо <select> и модалки.
 *
 * Та же механика, что у ConfirmDialog: очередь запросов на уровне модуля,
 * `await chooseOption({...})` из любого обработчика, один <ChoiceHost/> в App.
 * Причина отказа чека («нет суммы / чужой чек / повтор / другое») и выбор
 * курса, когда сумма не прочиталась, — оба через него.
 */
export type ChoiceOption = { value: string; label: string; hint?: string; danger?: boolean };

type Request = {
  id: number;
  title: string;
  options: ChoiceOption[];
  resolve: (value: string | null) => void;
};

let counter = 0;
let queue: Request[] = [];
const listeners = new Set<(current: Request | null) => void>();

function emit() {
  const current = queue[0] ?? null;
  for (const l of listeners) l(current);
}

/** null — человек закрыл лист, ничего не выбрав. */
export function chooseOption(opts: { title: string; options: ChoiceOption[] }): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    queue = [...queue, { ...opts, id: ++counter, resolve }];
    emit();
  });
}

function settle(id: number, value: string | null) {
  const req = queue.find((r) => r.id === id);
  if (!req) return;
  queue = queue.filter((r) => r.id !== id);
  req.resolve(value);
  emit();
}

export function ChoiceHost() {
  const [current, setCurrent] = useState<Request | null>(queue[0] ?? null);
  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  if (!current) return null;
  return (
    <Sheet open label={current.title} onClose={() => settle(current.id, null)}>
      <div className="sheet-title">{current.title}</div>
      <div className="choice-list">
        {current.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`choice ${o.danger ? "danger" : ""}`}
            onClick={() => settle(current.id, o.value)}
          >
            <span className="choice-label">{o.label}</span>
            {o.hint && <span className="choice-hint">{o.hint}</span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
