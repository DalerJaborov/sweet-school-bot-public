import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Lightbox } from "../src/components/Lightbox";

afterEach(cleanup);

describe("Lightbox", () => {
  it("src = null — ничего не рисует и не вешает обработчик Esc", () => {
    const onClose = vi.fn();
    render(<Lightbox src={null} label="Фото" alt="Фото" onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("открыт: картинка, подпись диалога, кнопка «Закрыть»", () => {
    const onClose = vi.fn();
    render(<Lightbox src="/r.jpg" label="Фото чека целиком" alt="Чек целиком" onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Фото чека целиком" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByAltText("Чек целиком").getAttribute("src")).toBe("/r.jpg");

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc и клик мимо закрывают", () => {
    const onClose = vi.fn();
    render(<Lightbox src="/r.jpg" label="Фото" alt="Фото" onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
