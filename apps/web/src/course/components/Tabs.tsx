import { useRef, type KeyboardEvent } from "react";

/**
 * Вкладки экрана урока: Рецепт | Фото | Вопрос. Обычный role=tablist со
 * стрелками влево/вправо, Home/End — так их читают TalkBack и VoiceOver.
 * Панели рисует родитель по id из `tabId`/`panelId`.
 */
export type Tab = { id: string; label: string };

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

export function Tabs({
  prefix,
  tabs,
  active,
  onChange,
  label,
}: {
  prefix: string;
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            id={tabId(prefix, tab.id)}
            role="tab"
            type="button"
            className={selected ? "tab on" : "tab"}
            aria-selected={selected}
            aria-controls={panelId(prefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
