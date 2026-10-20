import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { EscapeInAppScreen } from "../src/course/screens/EscapeInAppScreen";
import type { Environment } from "../src/course/install/detect";
import { dict } from "../src/course/i18n";

const t = dict("ru");
const ios: Environment = { platform: "ios", standalone: false, inApp: true, browser: "other" };
const android: Environment = { platform: "android", standalone: false, inApp: true, browser: "other" };

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/course?token=abc");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Экран «откройте в браузере» (дизайн доступа 03.09.2026): токен остаётся в
 * адресе и уезжает в Safari/Chrome вместе с ним; если схема не сработала —
 * через полторы секунды показываем ручные шаги и «Скопировать».
 */
describe("EscapeInAppScreen", () => {
  it("iOS: кнопка «Открыть в Safari» ведёт по x-safari-https с токеном", () => {
    const navigate = vi.fn();
    render(<EscapeInAppScreen t={t} env={ios} navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Safari" }));
    expect(navigate).toHaveBeenCalledWith(`x-safari-https://${window.location.host}/course?token=abc`);
    expect(screen.queryByText(t.escapeManualIos)).toBeNull();
  });

  it("iOS: остались на экране через 1.5 с — показываем ручные шаги «•••»", () => {
    render(<EscapeInAppScreen t={t} env={ios} navigate={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Safari" }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText(t.escapeManualIos)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Скопировать ссылку" })).toBeTruthy();
  });

  it("ушли в браузер (страница скрыта) — шаги не показываем", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<EscapeInAppScreen t={t} env={ios} navigate={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Safari" }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(t.escapeManualIos)).toBeNull();
  });

  it("Android: intent:// с запасным адресом и своя подсказка «⋮ → Chrome»", () => {
    const navigate = vi.fn();
    render(<EscapeInAppScreen t={t} env={android} navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Chrome" }));
    const url = navigate.mock.calls[0][0] as string;
    expect(url.startsWith(`intent://${window.location.host}/course?token=abc#Intent;scheme=https;`)).toBe(true);
    expect(url).toContain(`S.browser_fallback_url=${encodeURIComponent(window.location.href)}`);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText(t.escapeManualAndroid)).toBeTruthy();
  });

  it("«Скопировать ссылку» кладёт текущий адрес с токеном в буфер", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<EscapeInAppScreen t={t} env={ios} navigate={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в Safari" }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(window.location.href).toContain("token=abc");
    expect(screen.getByRole("button", { name: "Ссылка скопирована" })).toBeTruthy();
  });
});
