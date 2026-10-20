import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { haptic, prepareTelegramViewport, useTelegramClosingGuard } from "../src/telegram";
import { Sheet } from "../src/components/Sheet";

/**
 * Мини-приложение Telegram («Утро Ширин» §20): отдача в палец, полный экран,
 * «точно закрыть?» при несохранённом и кнопка «Назад» вместо крестика — всё
 * только при наличии window.Telegram.WebApp, а в браузере панель работает
 * ровно так же, без них.
 */
afterEach(() => {
  cleanup();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

function installWebApp(overrides: Record<string, unknown> = {}) {
  const back = { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() };
  const tg = {
    initData: "x",
    ready: vi.fn(),
    expand: vi.fn(),
    isVersionAtLeast: vi.fn(() => true),
    requestFullscreen: vi.fn(),
    disableVerticalSwipes: vi.fn(),
    enableClosingConfirmation: vi.fn(),
    disableClosingConfirmation: vi.fn(),
    BackButton: back,
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn(), selectionChanged: vi.fn() },
    ...overrides,
  };
  (window as unknown as { Telegram?: unknown }).Telegram = { WebApp: tg };
  return tg;
}

describe("haptic", () => {
  it("вне Telegram — ничего не делает и не падает", () => {
    expect(() => {
      haptic("success");
      haptic("light");
      haptic("selection");
    }).not.toThrow();
  });

  it("внутри Telegram выбирает нужный тип отдачи", () => {
    const tg = installWebApp();
    haptic("success");
    haptic("medium");
    haptic("selection");
    expect(tg.HapticFeedback.notificationOccurred).toHaveBeenCalledWith("success");
    expect(tg.HapticFeedback.impactOccurred).toHaveBeenCalledWith("medium");
    expect(tg.HapticFeedback.selectionChanged).toHaveBeenCalledTimes(1);
  });

  it("клиент бросил исключение — действие не роняем", () => {
    installWebApp({
      HapticFeedback: {
        impactOccurred: () => {
          throw new Error("unsupported");
        },
      },
    });
    expect(() => haptic("light")).not.toThrow();
  });
});

describe("prepareTelegramViewport", () => {
  it("вне Telegram — тишина", () => {
    expect(() => prepareTelegramViewport()).not.toThrow();
  });

  it("Bot API 8.0+ — полный экран и без свайпа-закрытия", () => {
    const tg = installWebApp();
    prepareTelegramViewport();
    expect(tg.expand).toHaveBeenCalled();
    expect(tg.disableVerticalSwipes).toHaveBeenCalled();
    expect(tg.requestFullscreen).toHaveBeenCalled();
  });

  it("старый клиент — только expand, без requestFullscreen", () => {
    const tg = installWebApp({ isVersionAtLeast: vi.fn(() => false) });
    prepareTelegramViewport();
    expect(tg.expand).toHaveBeenCalled();
    expect(tg.requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("useTelegramClosingGuard", () => {
  it("включает подтверждение, пока dirty, и выключает после", () => {
    const tg = installWebApp();
    const { rerender, unmount } = renderHook(({ dirty }) => useTelegramClosingGuard(dirty), { initialProps: { dirty: false } });
    expect(tg.enableClosingConfirmation).not.toHaveBeenCalled();
    rerender({ dirty: true });
    expect(tg.enableClosingConfirmation).toHaveBeenCalledTimes(1);
    unmount();
    expect(tg.disableClosingConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe("Sheet и кнопка «Назад»", () => {
  it("внутри Telegram регистрирует BackButton и не рисует крестик", () => {
    const tg = installWebApp();
    const onClose = vi.fn();
    const { unmount } = render(
      <Sheet open label="Ещё" onClose={onClose}>
        <p>содержимое</p>
      </Sheet>
    );
    expect(tg.BackButton.show).toHaveBeenCalledTimes(1);
    expect(tg.BackButton.onClick).toHaveBeenCalledWith(onClose);
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
    unmount();
    expect(tg.BackButton.hide).toHaveBeenCalledTimes(1);
    expect(tg.BackButton.offClick).toHaveBeenCalledWith(onClose);
  });

  it("в браузере — крестик закрывает лист", () => {
    const onClose = vi.fn();
    render(
      <Sheet open label="Ещё" onClose={onClose}>
        <p>содержимое</p>
      </Sheet>
    );
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
