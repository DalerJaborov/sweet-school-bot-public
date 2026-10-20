import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CoursesPage } from "../src/pages/CoursesPage";
import { ToastHost } from "../src/components/Toast";

/**
 * Список уроков (§8, §13): обложка и статус по-человечески, бейдж «с карточки,
 * не проверено» ведёт на проверку, название правится на месте.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lesson = {
  id: "l1",
  title: "Творожный пирог",
  order: 3,
  status: "READY",
  durationSec: 600,
  hasVideo: true,
  recipeText: "текст",
  recipePhotos: ["https://cdn.test/a.jpg"],
  recipeSource: "card-ocr",
  recipeReviewedAt: null,
  needsRecipeReview: true,
  coverUrl: "https://cdn.test/cover.jpg",
  isPreview: false,
  transcript: null,
  transcriptStatus: "PENDING",
  audioUrl: null,
};

let trashRows: Record<string, unknown>[] = [];

function mockApi() {
  trashRows = [];
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/admin/courses") {
        return new Response(
          JSON.stringify({
            storageReady: true,
            courses: [
              {
                id: "c1", code: "COURSE70", title: "21 рецепт", price: 70, active: true, students: 4, toolsData: [],
                modules: [{ id: "m1", title: "Уроки", order: 1, lessons: [lesson, { ...lesson, id: "l2", order: 4, title: "Эклеры", status: "PROCESSING", needsRecipeReview: false, recipeReviewedAt: "2026-09-05T00:00:00Z" }] }],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === "/admin/recipes/review-count") return new Response(JSON.stringify({ count: 2 }), { status: 200 });
      if (url === "/admin/lessons/trash") {
        return new Response(JSON.stringify({ rows: trashRows }), { status: 200 });
      }
      if (url === "/admin/lessons/l1" && method === "DELETE") {
        return new Response(JSON.stringify({ ok: true, undoUntil: "2026-09-06T10:00:00.000Z" }), { status: 200 });
      }
      if (url.endsWith("/restore") && method === "POST") return new Response(JSON.stringify({ ok: true, order: 3 }), { status: 200 });
      if (url === "/admin/lessons/l1" && method === "PUT") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("{}", { status: 404 });
    })
  );
  return calls;
}

describe("CoursesPage — уроки", () => {
  it("обложка, статус по-человечески, бейдж только у непроверенного OCR-рецепта, вход в проверку", async () => {
    mockApi();
    const onReview = vi.fn();
    render(<CoursesPage onReview={onReview} />);
    expect(await screen.findByRole("button", { name: "Творожный пирог" })).toBeTruthy();
    expect(screen.getByText("видео готовится, ~10 мин")).toBeTruthy();
    expect(screen.getByText("готов")).toBeTruthy();
    expect(document.querySelector('img[src="https://cdn.test/cover.jpg"]')).toBeTruthy();

    const badges = screen.getAllByRole("button", { name: "с карточки, не проверено" });
    expect(badges).toHaveLength(1);
    fireEvent.click(badges[0]);
    expect(onReview).toHaveBeenCalledWith("l1");

    fireEvent.click(await screen.findByRole("button", { name: "Проверить рецепты (2)" }));
    expect(onReview).toHaveBeenCalledWith(null);
  });

  it("тап по названию → поле; Enter сохраняет через PUT, Escape отменяет", async () => {
    const calls = mockApi();
    render(<CoursesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Творожный пирог" }));
    const input = screen.getByLabelText("Название урока") as HTMLInputElement;
    expect(input.value).toBe("Творожный пирог");
    fireEvent.change(input, { target: { value: "Творожный пирог с изюмом" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0]).toMatchObject({ url: "/admin/lessons/l1", body: { title: "Творожный пирог с изюмом" } });
    expect(screen.getByRole("button", { name: "Творожный пирог с изюмом" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Эклеры" }));
    const input2 = screen.getByLabelText("Название урока") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "Не сохранять" } });
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Эклеры" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("«Рецепт и видео» открывает лист сбоку, а не окно", async () => {
    mockApi();
    render(<CoursesPage />);
    await screen.findByRole("button", { name: "Творожный пирог" });
    fireEvent.click(screen.getAllByRole("button", { name: "Рецепт и видео" })[0]);
    const sheet = screen.getByRole("dialog", { name: "Рецепт и видео — Творожный пирог" });
    expect(sheet.className).toContain("sheet");
    expect(sheet.querySelector(".lesson-editor")).toBeTruthy();
  });

  it("«Удалить» — без окна «Точно?»: DELETE сразу, тост «Отменить» зовёт restore", async () => {
    const calls = mockApi();
    render(
      <>
        <CoursesPage />
        <ToastHost />
      </>
    );
    await screen.findByRole("button", { name: "Творожный пирог" });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Удалить" })[0]);
    });
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ url: "/admin/lessons/l1", method: "DELETE", body: undefined }]);
    expect(await screen.findByText("«Творожный пирог» в корзине")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/admin/lessons/l1/restore"]);
    expect(await screen.findByText("«Творожный пирог» возвращён")).toBeTruthy();
  });

  it("раздел «Корзина (N)» внизу: что лежит, сколько осталось, «Вернуть»", async () => {
    const calls = mockApi();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    trashRows = [
      { id: "l9", title: "Наполеон", module: "Уроки", course: "21 рецепт", deletedAt: "2026-09-05T10:00:00Z", purgeAt: "2026-09-06T10:00:00Z" },
    ];
    render(<CoursesPage />);
    const summary = await screen.findByText("Корзина (1)");
    fireEvent.click(summary);
    expect(screen.getByText("Наполеон")).toBeTruthy();
    expect(screen.getByText("ещё 22 ч")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));
    });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/admin/lessons/l9/restore"]);
    vi.useRealTimers();
  });

  it("корзина пуста — раздела нет", async () => {
    mockApi();
    render(<CoursesPage />);
    await screen.findByRole("button", { name: "Творожный пирог" });
    expect(screen.queryByText(/^Корзина/)).toBeNull();
  });
});
