import { useSyncExternalStore } from "react";

/**
 * НАСТРОЙКИ ВИДА ПАНЕЛИ — живут только на этом телефоне/компьютере.
 *
 * «Режим сестры» (простой режим): видны только Сегодня, Чеки, Клиенты.
 * «Тёмный вид»: по умолчанию светлый (решение владельца — цифры и чеки читаются
 * на светлом), тёмный включается вручную.
 *
 * Хранилище — localStorage; он может бросать исключение (приватное окно,
 * запрет сайтов), поэтому каждое обращение в try/catch, а значение держим ещё и
 * в памяти — переключатель срабатывает сразу и без записи на диск.
 */
const SIMPLE_KEY = "panel_simple";
const THEME_KEY = "panel_theme";

export type PanelTheme = "light" | "dark";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Память страницы всё равно хранит выбор до закрытия вкладки.
  }
}

let simple = read(SIMPLE_KEY) === "1";
let theme: PanelTheme = read(THEME_KEY) === "dark" ? "dark" : "light";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function isSimpleMode(): boolean {
  return simple;
}
export function setSimpleMode(on: boolean): void {
  simple = on;
  write(SIMPLE_KEY, on ? "1" : "0");
  emit();
}
export function useSimpleMode(): boolean {
  return useSyncExternalStore(subscribe, isSimpleMode, isSimpleMode);
}

export function currentTheme(): PanelTheme {
  return theme;
}
/** Цвет верхней полосы браузера и значка на телефоне — под палитру панели. */
const THEME_COLOR: Record<PanelTheme, string> = { light: "#f3f2ef", dark: "#151413" };

export function applyTheme(next: PanelTheme = theme): void {
  const root = document.documentElement;
  if (next === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[next]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", next);
}
export function setTheme(next: PanelTheme): void {
  theme = next;
  write(THEME_KEY, next);
  applyTheme(next);
  emit();
}
export function useTheme(): PanelTheme {
  return useSyncExternalStore(subscribe, currentTheme, currentTheme);
}
