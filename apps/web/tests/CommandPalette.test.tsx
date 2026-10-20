import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CommandPalette, SearchButton } from "../src/components/CommandPalette";
import type { SearchResponse } from "../src/api";

/**
 * ⌘K: открывается горячей клавишей и лупой в шапке, запрос уходит после
 * паузы и не короче двух букв, стрелки ходят по плоскому списку, Enter
 * выбирает, Esc закрывает.
 */
const response: SearchResponse = {
  q: "ма",
  students: [{ id: "c1", handle: "@madina", name: "Мадина", paid: true, phone: null }],
  lessons: [{ id: "l1", title: "Макаронс", order: 4, course: "21 рецепт" }],
  sections: [{ tab: "texts", title: "Тексты и цены" }],
};

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(response), { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function hotkey() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
}

describe("CommandPalette", () => {
  it("закрыта до Ctrl+K; открывается с фокусом в поле, Esc закрывает", () => {
    render(<CommandPalette onSelect={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(hotkey);
    const input = screen.getByRole("combobox");
    expect(screen.getByRole("dialog", { name: "Поиск по панели" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("лупа в шапке открывает ту же палитру", () => {
    render(
      <>
        <SearchButton />
        <CommandPalette onSelect={vi.fn()} />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Поиск" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("одна буква — запроса нет; две — уходит после паузы, результаты по группам", async () => {
    render(<CommandPalette onSelect={vi.fn()} />);
    act(hotkey);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "м" } });
    await new Promise((r) => setTimeout(r, 260));
    expect(calls).toEqual([]);

    fireEvent.change(input, { target: { value: "ма" } });
    const options = await screen.findAllByRole("option");
    expect(calls).toEqual(["/admin/search?q=%D0%BC%D0%B0"]);
    expect(options.map((o) => o.textContent)).toEqual(["Тексты и цены" + "раздел", "@madina" + "Мадина · оплатила", "Макаронс" + "урок 4 · 21 рецепт"]);
    expect(screen.getByRole("group", { name: "Ученицы" })).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBe("cmdk-opt-0");
  });

  it("стрелка вниз + Enter выбирает вторую строку и закрывает палитру", async () => {
    const onSelect = vi.fn();
    render(<CommandPalette onSelect={onSelect} />);
    act(hotkey);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "ма" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("cmdk-opt-1");
    expect(screen.getByRole("option", { name: /@madina/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ type: "student", id: "c1", title: "@madina", sub: "Мадина · оплатила" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("клик по разделу отдаёт tab", async () => {
    const onSelect = vi.fn();
    render(<CommandPalette onSelect={onSelect} />);
    act(hotkey);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "цена" } });
    fireEvent.click(await screen.findByRole("option", { name: /Тексты и цены/ }));
    expect(onSelect).toHaveBeenCalledWith({ type: "section", tab: "texts", title: "Тексты и цены", sub: "раздел" });
  });
});
