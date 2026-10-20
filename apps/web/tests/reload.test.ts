import { describe, it, expect, vi, afterEach } from "vitest";
import { reloadWithoutToken } from "../src/course/install/reload";

/**
 * Регрессия 05.09.2026: reloadWithoutToken звал window.location.replace(pathname).
 * Для короткой ссылки /l/<код> код живёт в самом пути — «оставить путь как
 * есть» перезагружало ту же /l/<код> бесконечно (bootstrap находил код снова
 * при каждой перезагрузке). Цель — всегда фиксированный /course, а не текущий
 * pathname, независимо от того, с какого адреса пришли.
 */
describe("reloadWithoutToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("всегда ведёт на /course, а не на текущий путь — короткая ссылка не зацикливается", () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, pathname: "/l/hS5c4WcmAx", replace },
      writable: true,
    });
    reloadWithoutToken();
    expect(replace).toHaveBeenCalledWith("/course");
    expect(replace).not.toHaveBeenCalledWith("/l/hS5c4WcmAx");
  });

  it("тот же результат для старой ссылки /course?token=…", () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, pathname: "/course", replace },
      writable: true,
    });
    reloadWithoutToken();
    expect(replace).toHaveBeenCalledWith("/course");
  });
});
