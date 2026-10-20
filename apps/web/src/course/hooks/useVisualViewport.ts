import { useEffect, useState } from "react";

/**
 * Высота ВИДИМОЙ части окна. На iPhone экранная клавиатура не уменьшает
 * `100vh`/`100dvh`, а наезжает поверх: поле ввода в чате оказывалось под ней,
 * и человек писал вслепую. `visualViewport` знает настоящую высоту — по ней
 * и растягиваем страницу чата (см. screens/ChatPage.tsx).
 *
 * null — API нет (старые браузеры): тогда работает обычная вёрстка на 100dvh.
 */
export function useVisualViewport(): number | null {
  const [height, setHeight] = useState<number | null>(() => window.visualViewport?.height ?? null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(Math.round(vv.height));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}
