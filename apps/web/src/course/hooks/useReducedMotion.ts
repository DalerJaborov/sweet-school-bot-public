import { useSyncExternalStore } from "react";
const query = "(prefers-reduced-motion: reduce)";
function subscribe(notify: () => void) {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}
function snapshot() {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
