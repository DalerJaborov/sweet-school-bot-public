import { useCallback, useEffect, useState } from "react";

/** Событие Chrome/Android: браузер готов предложить установку. */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * `beforeinstallprompt` прилетает один раз, вскоре после загрузки — ДО того,
 * как ученица откроет первый урок и на Главной появится карточка установки.
 * Поэтому ловим его на уровне модуля, а хук лишь читает пойманное.
 */
let captured: BeforeInstallPromptEvent | null = null;
let installedFlag = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Без preventDefault Chrome показал бы свою мини-плашку сам — не там и
    // не тогда, когда нужно нам.
    e.preventDefault();
    captured = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installedFlag = true;
    captured = null;
    notify();
  });
}

/** Для тестов: подложить событие, как будто браузер его прислал. */
export function _setCapturedForTests(ev: BeforeInstallPromptEvent | null, installed = false): void {
  captured = ev;
  installedFlag = installed;
  notify();
}

export function useInstallPrompt() {
  const [, bump] = useState(0);

  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const install = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    const ev = captured;
    if (!ev) return "unavailable";
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      // Событие одноразовое: после ответа Chrome его не повторит.
      captured = null;
      notify();
      return outcome;
    } catch {
      return "unavailable";
    }
  }, []);

  return { canPrompt: captured !== null, installed: installedFlag, install };
}
