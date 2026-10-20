import { describe, it, expect, beforeEach } from "vitest";
import { applyTheme, initTheme, THEME_KEY } from "../src/course/theme";

/**
 * СВЕТЛАЯ ПО УМОЛЧАНИЮ (владелец 03.09.2026): тёмная — только явным
 * выбором, сохранённым в localStorage; настройки телефона не учитываются.
 */
describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("без сохранённого выбора — светлая, атрибута нет", () => {
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("сохранённая тёмная — data-theme=dark до рендера", () => {
    localStorage.setItem(THEME_KEY, "dark");
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});
