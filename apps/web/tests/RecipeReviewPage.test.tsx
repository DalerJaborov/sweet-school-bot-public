import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RecipeReviewPage } from "../src/pages/RecipeReviewPage";
import type { LessonRecipe, RecipeCard, ReviewRow } from "../src/api";

/**
 * Проверка OCR-рецептов: список ждущих → карточка с фото и строками →
 * «Проверила ✓» шлёт отредактированную структуру, а сервер собирает из неё
 * текст сам.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card: RecipeCard = {
  title: "Творожный пирог",
  language: "tg",
  components: [
    { name: "Хамир", items: [{ ingredient: "Орд", amount: "250", unit: "г", note: null, emoji: "🌾" }, { ingredient: "Тухм", amount: "2", unit: "дона", note: null, emoji: "🥚" }] },
  ],
};

const lesson: LessonRecipe = {
  id: "l1",
  title: "Творожный пирог",
  order: 3,
  module: "Уроки",
  course: "21 рецепт",
  recipeSource: "card-ocr",
  recipeReviewedAt: null,
  needsReview: true,
  recipeText: "**Хамир**\n- Орд — 250 г",
  recipeData: card,
  photos: ["https://cdn.test/a.jpg"],
};

const rows: ReviewRow[] = [{ id: "l1", title: "Творожный пирог", order: 3, module: "Уроки", course: "21 рецепт", coverUrl: null, photos: 1 }];

function mockApi() {
  const calls: { url: string; method: string; body?: { recipeData: RecipeCard } }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/admin/recipes/review") return new Response(JSON.stringify({ rows }), { status: 200 });
      if (url === "/admin/lessons/l1/recipe" && method === "GET") return new Response(JSON.stringify(lesson), { status: 200 });
      if (url === "/admin/lessons/l1/recipe" && method === "PUT") return new Response(JSON.stringify({ ok: true, reviewLeft: 0 }), { status: 200 });
      return new Response("{}", { status: 404 });
    })
  );
  return calls;
}

describe("RecipeReviewPage", () => {
  it("список: урок с карточкой, «Проверить» открывает его", async () => {
    mockApi();
    const onOpen = vi.fn();
    render(<RecipeReviewPage lessonId={null} onOpen={onOpen} onBack={() => undefined} />);
    expect(await screen.findByText("3. Творожный пирог")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(onOpen).toHaveBeenCalledWith("l1");
  });

  it("карточка: фото с зумом, правка граммовки и строки, «Проверила ✓» шлёт структуру", async () => {
    const calls = mockApi();
    const onOpen = vi.fn();
    render(<RecipeReviewPage lessonId="l1" onOpen={onOpen} onBack={() => undefined} />);
    expect(await screen.findByAltText("Карточка рецепта 1")).toBeTruthy();
    expect(screen.getByText(/с карточки, не проверено/)).toBeTruthy();

    // Зум по кнопке.
    fireEvent.click(screen.getByRole("button", { name: "Увеличить" }));
    expect(screen.getByRole("button", { name: "Уменьшить" })).toBeTruthy();

    // Поправили «250» → «260», убрали вторую строку, добавили новую.
    const amounts = screen.getAllByLabelText("Количество") as HTMLInputElement[];
    expect(amounts[0].value).toBe("250");
    fireEvent.change(amounts[0], { target: { value: "260" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Убрать строку" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "+ Строка" }));
    const ingredients = screen.getAllByLabelText("Ингредиент") as HTMLInputElement[];
    expect(ingredients).toHaveLength(2);
    fireEvent.change(ingredients[1], { target: { value: "Шакар" } });
    fireEvent.change(screen.getAllByLabelText("Количество")[1], { target: { value: "100" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Проверила ✓" }));
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/admin/lessons/l1/recipe");
    expect(put?.body?.recipeData.components[0].items).toEqual([
      { ingredient: "Орд", amount: "260", unit: "г", note: null, emoji: "🌾" },
      { ingredient: "Шакар", amount: "100", unit: null, note: null, emoji: null },
    ]);
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  it("без единого ингредиента кнопка неактивна", async () => {
    mockApi();
    render(<RecipeReviewPage lessonId="l1" onOpen={() => undefined} onBack={() => undefined} />);
    await screen.findByAltText("Карточка рецепта 1");
    // По одной, свежим запросом: после каждого удаления список перерисовывается.
    while (screen.queryAllByRole("button", { name: "Убрать строку" }).length > 0) {
      fireEvent.click(screen.getAllByRole("button", { name: "Убрать строку" })[0]);
    }
    expect((screen.getByRole("button", { name: "Проверила ✓" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
