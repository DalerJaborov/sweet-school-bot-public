import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ConfirmHost, confirmDialog } from "../src/components/ConfirmDialog";

afterEach(cleanup);

/** Запрос уходит снаружи React (как из обработчика клика в странице), после
 *  чего act() даёт React дорисовать окно. */
async function open(opts: Parameters<typeof confirmDialog>[0]): Promise<{ result: Promise<boolean> }> {
  const result = confirmDialog(opts);
  await act(async () => {});
  return { result };
}

describe("ConfirmDialog", () => {
  it("без запросов ничего не рисует", () => {
    render(<ConfirmHost />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("кнопка называется по действию, необратимое — красная (danger)", async () => {
    render(<ConfirmHost />);
    const { result: promise } = await open({ title: "Отобрать доступ у @client?", message: "Его выгонит из групп.", confirmLabel: "Отобрать", danger: true });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Отобрать доступ у @client?").tagName).toBe("H3");
    expect(screen.getByText("Его выгонит из групп.")).toBeTruthy();

    const confirm = screen.getByRole("button", { name: "Отобрать" });
    expect(confirm.classList.contains("danger")).toBe(true);
    // Фокус — на безопасной кнопке: случайный Enter не отберёт доступ.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отмена" }));

    await act(async () => {
      fireEvent.click(confirm);
    });
    await expect(promise).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("обычное действие — кнопка без danger, «Отмена» → false", async () => {
    render(<ConfirmHost />);
    const { result: promise } = await open({ title: "Подтвердить чек?", confirmLabel: "Подтвердить" });

    expect(screen.getByRole("button", { name: "Подтвердить" }).classList.contains("danger")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    });
    await expect(promise).resolves.toBe(false);
  });

  it("Esc и клик по оверлею — отказ", async () => {
    render(<ConfirmHost />);
    const { result: p1 } = await open({ title: "Удалить?" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await expect(p1).resolves.toBe(false);

    const { result: p2 } = await open({ title: "Удалить?" });
    await act(async () => {
      fireEvent.click(screen.getByRole("alertdialog").parentElement!);
    });
    await expect(p2).resolves.toBe(false);
  });

  it("два запроса подряд показываются по одному, в порядке очереди", async () => {
    render(<ConfirmHost />);
    const { result: first } = await open({ title: "Первый?" });
    const { result: second } = await open({ title: "Второй?" });

    expect(screen.getByText("Первый?")).toBeTruthy();
    expect(screen.queryByText("Второй?")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    });
    await expect(first).resolves.toBe(true);
    expect(screen.getByText("Второй?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    });
    await expect(second).resolves.toBe(false);
  });
});

/**
 * promptDialog — замена window.prompt, который Telegram подавляет: без него
 * «+ Раздел» и «+ Урок» у владелицы молча не делали ничего.
 */
describe("promptDialog", () => {
  it("возвращает введённую строку по Enter, обрезая пробелы", async () => {
    const { promptDialog } = await import("../src/components/ConfirmDialog");
    render(<ConfirmHost />);
    const p = promptDialog({ title: "Название раздела", initial: "Раздел 1" });
    await act(async () => {});
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Раздел 1");
    fireEvent.change(input, { target: { value: "  Торты  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await p).toBe("Торты");
  });

  it("Escape и пустое поле — null: «Раздел без имени» не заводим", async () => {
    const { promptDialog } = await import("../src/components/ConfirmDialog");
    render(<ConfirmHost />);
    const p = promptDialog({ title: "Название урока" });
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Подтвердить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await p).toBeNull();
  });
});
