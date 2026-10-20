/**
 * ТЕМА — СВЕТЛАЯ ПО УМОЛЧАНИЮ (решение владельца 03.09.2026).
 *
 * Раньше тёмная включалась сама по prefers-color-scheme, и ученица с тёмным
 * телефоном видела не тот экран, что на скриншотах школы. Теперь тёмная —
 * только по явному нажатию на солнце/луну в шапке; выбор живёт в
 * localStorage и ставится атрибутом data-theme на <html>, чтобы CSS-токены
 * переключались одним селектором.
 *
 * initTheme() вызывается до первого рендера (main.tsx): иначе при перезагрузке
 * тёмный экран на миг мигал бы белым.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_KEY = "ssb_theme";

function readStored(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    // Приватный режим или запрет хранилища — остаёмся на светлой.
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

export function initTheme(): void {
  applyTheme(readStored());
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readStored);

  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "dark") localStorage.setItem(THEME_KEY, "dark");
      else localStorage.removeItem(THEME_KEY);
    } catch {
      // Не сохранилось — тема всё равно применена до перезагрузки.
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}
