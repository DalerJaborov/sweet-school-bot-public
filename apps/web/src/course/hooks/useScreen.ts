import { useCallback, useEffect, useState } from "react";

/**
 * ЭКРАНЫ БЕЗ РОУТЕРА.
 *
 * Адрес в строке не меняется (ссылка одна — /course), но каждый переход
 * кладётся в историю браузера через pushState. Иначе аппаратная кнопка
 * «назад» на Android закрывала бы приложение целиком вместо возврата к
 * списку уроков — а это первая кнопка, которую нажимает человек, впервые
 * увидевший чужой экран (решение 03.09.2026).
 *
 * После перезагрузки всегда открывается Главная: ссылка из переписки ведёт на
 * школу, а не на видео, чтобы урок не заиграл сам в тишине.
 */

export type Screen =
  | { name: "home" }
  | { name: "course"; courseId: string }
  | { name: "lesson"; lessonId: string; startAt: number; nonce: number }
  | { name: "chat"; lessonId: string | null }
  /** Набор инструментов курса (визуальная система 04.09.2026, §5). */
  | { name: "tools"; courseId: string };

type HistoryState = { screen: Screen; depth: number } | null;

const HOME: Screen = { name: "home" };

function readState(): HistoryState {
  const s = window.history.state as { screen?: Screen; depth?: number } | null;
  return s && s.screen && typeof s.depth === "number" ? { screen: s.screen, depth: s.depth } : null;
}

export function useScreen() {
  const [screen, setScreen] = useState<Screen>(HOME);

  useEffect(() => {
    // Токен из адреса убирает useCourse через replaceState, сохраняя state, —
    // поэтому мы кладём свой state поверх существующего, а не вместо.
    window.history.replaceState({ ...(window.history.state ?? {}), screen: HOME, depth: 0 }, "");
    const onPop = () => setScreen(readState()?.screen ?? HOME);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: Screen) => {
    const depth = (readState()?.depth ?? 0) + 1;
    window.history.pushState({ screen: next, depth }, "");
    setScreen(next);
  }, []);

  /** Назад по истории; если ниже нашей записи ничего нет — просто Домой. */
  const back = useCallback(() => {
    if ((readState()?.depth ?? 0) > 0) window.history.back();
    else {
      window.history.replaceState({ screen: HOME, depth: 0 }, "");
      setScreen(HOME);
    }
  }, []);

  const home = useCallback(() => {
    window.history.replaceState({ screen: HOME, depth: 0 }, "");
    setScreen(HOME);
  }, []);

  return { screen, go, back, home };
}
