import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "../hooks/useCountUp";

/**
 * КАРТОЧКА УЕЗЖАЕТ И СХЛОПЫВАЕТСЯ («Утро Ширин» §17). Подтвердили чек —
 * карточка сдвигается вправо, растворяется, а место под ней закрывается
 * плавно, чтобы список не дёргался. Нажали «Отменить» в тосте — open снова
 * true, и карточка раскрывается обратно.
 *
 * Без библиотеки: высота меряется по scrollHeight и анимируется CSS-переходом
 * (auto анимировать нельзя, поэтому фиксируем px на время перехода). После
 * схлопывания содержимое размонтируется — иначе кнопки оставались бы в
 * табе-порядке у невидимой карточки. В jsdom transitionend не приходит,
 * поэтому есть страховочный таймер чуть длиннее перехода.
 */
export const COLLAPSE_MS = 220;

export function Collapse({ open, children, testId }: { open: boolean; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<"open" | "leaving" | "closed">(open ? "open" : "closed");

  useLayoutEffect(() => {
    const el = ref.current;
    if (open) {
      setMounted(true);
      setPhase("open");
      if (el) el.style.height = "";
      return;
    }
    if (!el || phase === "closed") return;
    if (prefersReducedMotion()) {
      setMounted(false);
      setPhase("closed");
      return;
    }
    // Сначала фиксируем текущую высоту в px, следующим кадром — в 0: только
    // так у CSS-перехода есть откуда ехать.
    el.style.height = `${el.scrollHeight}px`;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    el.offsetHeight;
    setPhase("leaving");
    el.style.height = "0px";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const t = setTimeout(() => {
      setPhase("closed");
      setMounted(false);
    }, COLLAPSE_MS + 40);
    return () => clearTimeout(t);
  }, [phase]);

  if (!mounted) return null;
  return (
    <div ref={ref} className={`collapse ${phase}`} data-testid={testId} aria-hidden={phase !== "open" || undefined}>
      {children}
    </div>
  );
}
