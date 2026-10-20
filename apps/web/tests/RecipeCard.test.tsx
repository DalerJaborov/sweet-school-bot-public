import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { toPng } from "html-to-image";
import { RecipeCard, scaleAmount } from "../src/course/components/RecipeCard";
import { dict } from "../src/course/i18n";
import type { RecipeCardData } from "../src/course/api";

afterEach(cleanup);

const t = dict("ru");

// toPng рисует реальный canvas из DOM — в jsdom это ни разу не нужно, и без
// мока падает: тестируем СВОЁ поведение (какая ветка шаринга сработала), а не
// саму библиотеку рендера картинки. mockResolvedValue — в beforeEach, а не тут:
// vitest.config.ts включает restoreMocks, и он сбрасывает реализацию,
// заданную один раз на уровне модуля, ещё до первого теста.
vi.mock("html-to-image", () => ({ toPng: vi.fn() }));

beforeEach(() => {
  vi.mocked(toPng).mockResolvedValue("data:image/png;base64,AAAA");
});

function card(over: Partial<RecipeCardData> = {}): RecipeCardData {
  return {
    title: "Творожный пирог",
    language: "tg",
    components: [
      {
        name: "Хамир",
        items: [
          { ingredient: "Орд", amount: "250", unit: "г", note: null, emoji: "🌾" },
          { ingredient: "Тухм", amount: "2", unit: "дона", note: null, emoji: "🥚" },
        ],
      },
    ],
    ...over,
  };
}

describe("scaleAmount — пересчёт порции", () => {
  it("×1 не трогает исходную строку", () => {
    expect(scaleAmount("250", 1)).toBe("250");
  });
  it("целые числа округляются до целых, не до нуля", () => {
    expect(scaleAmount("250", 0.5)).toBe("125");
    expect(scaleAmount("2", 0.5)).toBe("1");
    expect(scaleAmount("250", 2)).toBe("500");
    expect(scaleAmount("1", 0.5)).toBe("1"); // не 0 — единица осталась бы неизмеримой
  });
  it("дроби и диапазоны не трогаем — показываем как написано", () => {
    expect(scaleAmount("1/2", 2)).toBe("1/2");
    expect(scaleAmount("2-3", 0.5)).toBe("2-3");
    expect(scaleAmount(null, 2)).toBeNull();
  });
});

describe("RecipeCard — без recipeData", () => {
  it("падает на обычный текст рецепта (текущее поведение)", () => {
    render(<RecipeCard t={t} title="Наполеон" number={1} recipeData={null} fallbackText="Мука 250 г" />);
    expect(screen.getByText("Мука 250 г")).toBeTruthy();
  });
  it("нет ни recipeData, ни текста — «рецепт не добавлен»", () => {
    render(<RecipeCard t={t} title="Наполеон" number={1} recipeData={null} fallbackText={null} />);
    expect(screen.getByText(t.noRecipe)).toBeTruthy();
  });
});

describe("RecipeCard — структурированный рецепт", () => {
  it("плашка урока, группы жирным, ингредиенты с эмодзи и граммовкой", () => {
    render(<RecipeCard t={t} title="Творожный пирог" number={15} recipeData={card()} fallbackText={null} />);
    // Карточка рендерится дважды — видимая и скрытая копия для экспорта в PNG
    // (§2: «рендерит тот же компонент»), поэтому текст встречается дважды.
    expect(screen.getAllByText("УРОК 15").length).toBe(2);
    expect(screen.getAllByText("Хамир").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Орд").length).toBeGreaterThan(0);
    expect(screen.getAllByText("250 г").length).toBeGreaterThan(0);
  });

  it("чекбокс собранного ингредиента темнеет (is-checked)", () => {
    const { container } = render(
      <RecipeCard t={t} title="Творожный пирог" number={1} recipeData={card()} fallbackText={null} />,
    );
    const box = screen.getAllByRole("checkbox")[0];
    fireEvent.click(box);
    expect(container.querySelector(".ingredient-row.is-checked")).toBeTruthy();
    fireEvent.click(box);
    expect(container.querySelector(".ingredient-row.is-checked")).toBeNull();
  });

  it("переключатель ×0.5/×1/×2 пересчитывает граммы на видимой карточке", () => {
    render(<RecipeCard t={t} title="Творожный пирог" number={1} recipeData={card()} fallbackText={null} />);
    fireEvent.click(screen.getByRole("button", { name: "×0.5" }));
    expect(screen.getAllByText("125 г").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "×2" }));
    expect(screen.getAllByText("500 г").length).toBeGreaterThan(0);
  });

  it("«Отправить в WhatsApp» без Web Share API скачивает картинку, не выдавая успех молча", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    // jsdom не реализует createObjectURL/revokeObjectURL — подставляем сами.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => "blob:mock");
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();

    render(<RecipeCard t={t} title="Творожный пирог" number={1} recipeData={card()} fallbackText={null} />);
    fireEvent.click(screen.getByRole("button", { name: t.sendToWhatsapp }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());

    clickSpy.mockRestore();
  });
});
