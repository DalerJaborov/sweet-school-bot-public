import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ToolsScreen } from "../src/course/screens/ToolsScreen";
import { dict } from "../src/course/i18n";
import type { CourseInfo } from "../src/course/api";

afterEach(cleanup);

const t = dict("ru");

function course(over: Partial<CourseInfo> = {}): CourseInfo {
  return {
    id: "c1",
    code: "COURSE50",
    title: "Курс",
    description: null,
    purchaseId: "p1",
    modules: [],
    ...over,
  };
}

/**
 * ЭКРАН «НАБОР ИНСТРУМЕНТОВ» (§5): фото есть не у всех инструментов — тест
 * проверяет оба случая, чтобы плейсхолдер не превратился в сломанную <img>.
 */
describe("ToolsScreen", () => {
  it("пустой список — понятное сообщение, а не пустой экран", () => {
    render(<ToolsScreen t={t} course={course({ toolsData: [] })} onBack={vi.fn()} />);
    expect(screen.getByText(t.noTools)).toBeTruthy();
  });

  it("инструмент с фото — картинка, номер и ссылка «где купить»", () => {
    const { container } = render(
      <ToolsScreen
        t={t}
        course={course({
          toolsData: [{ name: "Насадка", photoUrl: "https://x/y.jpg", toolNumber: "847", buyLink: "https://shop" }],
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("Насадка")).toBeTruthy();
    expect(screen.getByText("№ 847")).toBeTruthy();
    // alt="" намеренно (фото декоративное — LessonCard/photos делают так же),
    // поэтому у <img> нет доступной роли "img": ищем по CSS, не по роли.
    expect(container.querySelector("img")).toHaveAttribute("src", "https://x/y.jpg");
    expect(container.querySelector(".tool-photo-ph")).toBeNull();
    expect(screen.getByRole("link", { name: t.buyInDushanbe })).toHaveAttribute("href", "https://shop");
  });

  it("инструмент без фото — плейсхолдер вместо сломанной картинки, без ссылки «купить»", () => {
    const { container } = render(
      <ToolsScreen
        t={t}
        course={course({ toolsData: [{ name: "Форма", photoUrl: null, toolNumber: null, buyLink: null }] })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("Форма")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByLabelText(t.toolPhotoMissing)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
