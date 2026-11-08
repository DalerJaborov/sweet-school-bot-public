import { useSyncExternalStore } from "react";
import { isInsideTelegram } from "../telegram";

/**
 * PWA ПАНЕЛИ: «Установить на телефон» и оболочка без сети.
 *
 * Панель живёт по адресу /panel/ со своим манифестом (public/panel.webmanifest)
 * и своим service worker (public/panel-sw.js, область /panel/). Приложение
 * учениц — другая область (/course, public/course-sw.js, manifest.webmanifest);
 * они не пересекаются, и тест tests/panelPwa.test.ts следит за этим.
 *
 * Service worker кладёт в память только саму оболочку (страница и статика).
 * Данные панели — чеки, клиенты, деньги — он не трогает никогда.
 */
export const PANEL_SCOPE = "/panel/";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function initPanelPwa(): void {
  // Внутри Telegram панель — мини-приложение; ставить на экран и кешировать
  // оболочку там не нужно, и мы ничего не меняем.
  if (isInsideTelegram()) return;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });

  // Адрес без косой черты вне области service worker и манифеста. Заменяем
  // его на месте, без перезагрузки и перехода по сети.
  if (location.pathname === "/panel")
    history.replaceState(null, "", `${PANEL_SCOPE}${location.search}${location.hash}`);

  if ("serviceWorker" in navigator && location.pathname.startsWith(PANEL_SCOPE)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/panel-sw.js", { scope: PANEL_SCOPE })
        .catch((e) => console.warn("panel sw", e));
    });
  }
}

export function canPromptInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null;
  emit();
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useCanPromptInstall(): boolean {
  return useSyncExternalStore(subscribe, canPromptInstall, canPromptInstall);
}

export type InstallPlatform = "ios" | "android" | "other";

export function detectPlatform(ua: string, maxTouchPoints = 0): InstallPlatform {
  // iPadOS 13+ называет себя Mac, но у него есть касания.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone) || window.matchMedia?.("(display-mode: standalone)").matches === true;
}
