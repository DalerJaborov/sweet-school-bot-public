import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { Onboarding } from "../src/course/Onboarding";
import * as api from "../src/course/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, "saveProfile").mockResolvedValue({ ok: true });
});

describe("Знакомство перед входом", () => {
  it("сначала язык, и подписан он самоназванием — понятно без перевода", () => {
    render(<Onboarding onDone={() => undefined} />);
    expect(screen.getByRole("button", { name: "Тоҷикӣ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Русский" })).toBeTruthy();
    // Пока язык не выбран, имя не спрашиваем: человек читал бы вопрос на чужом языке.
    expect(screen.queryByLabelText("Имя")).toBeNull();
  });

  it("после выбора таджикского вопрос про имя уже на таджикском", () => {
    render(<Onboarding onDone={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Тоҷикӣ" }));
    expect(screen.getByText("Номи шумо чист?")).toBeTruthy();
  });

  it("ГЛАВНОЕ: пустое имя не пропускаем — оно идёт в водяной знак поверх видео", async () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Русский" }));
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await act(async () => {});
    expect(screen.getByText("Впишите, пожалуйста, имя")).toBeTruthy();
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("фамилия НЕ обязательна: упереться в неё на входе значит потерять человека", async () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Русский" }));
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "  Малика  " } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("ru"));
    // Пробелы по краям обрезаны, пустая фамилия ушла пустой строкой.
    expect(api.saveProfile).toHaveBeenCalledWith({ firstName: "Малика", lastName: "", language: "ru" });
  });

  it("не сохранилось — человек остаётся на месте и видит, что случилось", async () => {
    vi.spyOn(api, "saveProfile").mockRejectedValue(new Error("сеть"));
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Русский" }));
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "Малика" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(screen.getByText("Не получилось сохранить. Попробуйте ещё раз.")).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("ошиблась языком — возвращается к выбору, не перезагружая страницу", () => {
    render(<Onboarding onDone={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Тоҷикӣ" }));
    fireEvent.click(screen.getByRole("button", { name: "Забон / Язык" }));
    expect(screen.getByRole("button", { name: "Русский" })).toBeTruthy();
  });
});
