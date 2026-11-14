import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MainSummaryBlock } from "../src/components/MainSummaryBlock";
import type { MainSummary } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MAIN: MainSummary = {
  money: { today: 170, salesToday: 2, week: 640, salesWeek: 9 },
  offline: { today: 1, week: 4 },
  pendingReceipts: 0,
  recent: [{ kind: "payment", who: "@madina", what: "21 рецепт, 70 с.", at: new Date().toISOString() }],
  bot: { ai: true, frozen: false, comments: true, funnelsOn: 1, funnelsPaused: false },
};

describe("Сегодня: главное сверху", () => {
  it("новые данные с сервера обновляют тумблеры (бота выключили из Telegram)", () => {
    const { rerender } = render(<MainSummaryBlock main={MAIN} onGetLink={() => undefined} />);
    expect((screen.getByTestId("switch-bot-ai") as HTMLInputElement).checked).toBe(true);
    rerender(<MainSummaryBlock main={{ ...MAIN, bot: { ...MAIN.bot, ai: false } }} onGetLink={() => undefined} />);
    expect((screen.getByTestId("switch-bot-ai") as HTMLInputElement).checked).toBe(false);
  });

  it("деньги, оплаты, офлайн-записи, последние события и кнопка «Получить ссылку» на виду", () => {
    const onGetLink = vi.fn();
    render(<MainSummaryBlock main={MAIN} onGetLink={onGetLink} />);
    expect(screen.getByText("Деньги сегодня")).toBeTruthy();
    expect(screen.getByText(/записей сегодня 1, за неделю 4/)).toBeTruthy();
    expect(screen.getByText("@madina")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Получить ссылку" }));
    expect(onGetLink).toHaveBeenCalledOnce();
  });

  it("тумблер бота переключается сразу и зовёт тот же API, что кнопки в Telegram", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ state: { ...MAIN.bot, ai: false }, lines: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<MainSummaryBlock main={MAIN} onGetLink={() => undefined} />);
    const sw = screen.getByTestId("switch-bot-ai") as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect(sw.checked).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/admin/v1/bot-control");
    expect(String(call[1].body)).toContain("ai_off");
  });
});
