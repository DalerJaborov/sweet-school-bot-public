import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

const store = vi.hoisted(() => ({
  wasLessonOpened: vi.fn(async () => true),
  loadInstallDismiss: vi.fn<() => Promise<{ count: number; at: number } | undefined>>(async () => undefined),
  dismissInstall: vi.fn(async () => ({ count: 1, at: 0 })),
}));
vi.mock("../src/course/offline", () => store);

import { InstallCard } from "../src/course/components/InstallCard";
import { _setCapturedForTests, type BeforeInstallPromptEvent } from "../src/course/hooks/useInstallPrompt";
import type { Environment } from "../src/course/install/detect";
import { dict } from "../src/course/i18n";

const t = dict("ru");
const DAY = 86_400_000;
const NOW = 100 * DAY;

const iosSafari: Environment = { platform: "ios", standalone: false, inApp: false, browser: "safari" };
const android: Environment = { platform: "android", standalone: false, inApp: false, browser: "chrome" };

function promptEvent(outcome: "accepted" | "dismissed" = "accepted"): BeforeInstallPromptEvent {
  return {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  } as unknown as BeforeInstallPromptEvent;
}

beforeEach(() => {
  store.wasLessonOpened.mockResolvedValue(true);
  store.loadInstallDismiss.mockResolvedValue(undefined);
  store.dismissInstall.mockClear();
  _setCapturedForTests(null, false);
});

afterEach(() => {
  cleanup();
  _setCapturedForTests(null, false);
});

async function settle() {
  await act(async () => {});
}

/**
 * Правила показа карточки установки (дизайн 03.09.2026): после первого урока,
 * не в приложении, не во встроенном браузере; отклонили — неделю молчим,
 * после трёх отказов — навсегда.
 */
describe("InstallCard: когда показываем", () => {
  it("iOS Safari после первого урока — три шага с «Поделиться»", async () => {
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await waitFor(() => expect(screen.getByText(t.installTitle)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t.installShowSteps }));
    expect(screen.getByText(t.installStep1)).toBeTruthy();
    expect(screen.getByText(t.installStep2)).toBeTruthy();
    expect(screen.getByText(t.installStep3)).toBeTruthy();
  });

  it("урок ещё не открывали — карточки нет", async () => {
    store.wasLessonOpened.mockResolvedValue(false);
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await settle();
    expect(screen.queryByText(t.installTitle)).toBeNull();
  });

  it.each([
    ["с экрана «Домой»", { ...iosSafari, standalone: true }],
    ["во встроенном браузере", { ...iosSafari, inApp: true, browser: "other" as const }],
    ["в Chrome на iOS (нет «Поделиться» Safari)", { ...iosSafari, browser: "chrome" as const }],
    ["на Android без beforeinstallprompt", android],
  ])("никогда: %s", async (_name, env) => {
    render(<InstallCard t={t} env={env} now={NOW} />);
    await settle();
    expect(screen.queryByText(t.installTitle)).toBeNull();
  });

  it("Android с beforeinstallprompt — кнопка «Установить» зовёт prompt()", async () => {
    const ev = promptEvent("accepted");
    _setCapturedForTests(ev);
    render(<InstallCard t={t} env={android} now={NOW} />);
    await waitFor(() => expect(screen.getByRole("button", { name: t.installButton })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t.installButton }));
    await settle();
    expect(ev.prompt).toHaveBeenCalled();
    expect(screen.queryByText(t.installTitle)).toBeNull();
  });

  it("«Не сейчас» записывает отказ; через 7 дней показываем снова, после 3 отказов — нет", async () => {
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await waitFor(() => expect(screen.getByText(t.installTitle)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t.notNow }));
    expect(store.dismissInstall).toHaveBeenCalledWith(NOW);
    expect(screen.queryByText(t.installTitle)).toBeNull();
    cleanup();

    // Отклонили 2 дня назад — рано.
    store.loadInstallDismiss.mockResolvedValue({ count: 1, at: NOW - 2 * DAY });
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await settle();
    expect(screen.queryByText(t.installTitle)).toBeNull();
    cleanup();

    // Прошла неделя — снова можно.
    store.loadInstallDismiss.mockResolvedValue({ count: 1, at: NOW - 8 * DAY });
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await waitFor(() => expect(screen.getByText(t.installTitle)).toBeTruthy());
    cleanup();

    // Три отказа — больше не надоедаем, сколько бы ни прошло.
    store.loadInstallDismiss.mockResolvedValue({ count: 3, at: NOW - 60 * DAY });
    render(<InstallCard t={t} env={iosSafari} now={NOW} />);
    await settle();
    expect(screen.queryByText(t.installTitle)).toBeNull();
  });
});
