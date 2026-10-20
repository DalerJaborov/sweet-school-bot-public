import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { DashboardPage } from "../src/pages/DashboardPage";
import { ToastHost } from "../src/components/Toast";
import { ChoiceHost } from "../src/components/ChoiceSheet";
import type { Today } from "../src/api";

/**
 * Главный экран «Сегодня» рисует плитки и очередь из одного ответа
 * GET /admin/today; действия в карточках зовут те же эндпоинты, что и
 * разделы (decide / reply / retranscode).
 */
const today: Today = {
  generatedAt: "2026-09-05T05:00:00Z",
  money: { yesterday: 120, dayBefore: 100, week: 220, prevWeek: 70, salesYesterday: 2, salesWeek: 4 },
  pendingReceipts: 1,
  unansweredQuestions: 1,
  notOpened: 1,
  sparkline: Array.from({ length: 14 }, (_, i) => ({ day: `2026-08-${23 + i}`, money: i * 10, sales: i % 2 })),
  queue: [
    {
      kind: "receipt",
      id: "r1",
      who: { contactId: "c1", handle: "@madina", instagramUrl: "https://www.instagram.com/madina/", channel: "INSTAGRAM" },
      imageUrl: "/media/r.jpg",
      amount: 70,
      courseGuess: "21 рецепт",
      reason: "похож",
      confidence: 61,
      createdAt: "2026-09-05T04:00:00Z",
    },
    { kind: "question", id: "q1", who: { contactId: "c2", handle: "@zarina", instagramUrl: null, channel: "WEB" }, text: "Можно молоко?", lesson: "Урок 3", createdAt: "2026-09-05T03:00:00Z" },
    { kind: "notOpened", who: { contactId: "c3", handle: "@nigora", instagramUrl: "https://www.instagram.com/nigora/", channel: "INSTAGRAM" }, paidAt: "2026-09-02T03:00:00Z", daysAgo: 3 },
    { kind: "transcodeFailed", lessonId: "l7", title: "Урок 7" },
    { kind: "gemini", calls: 850, limit: 1000, percent: 85 },
  ],
  goodNews: [
    { kind: "certificate", who: { contactId: "c4", handle: "@farida", instagramUrl: "https://www.instagram.com/farida/", channel: "INSTAGRAM" }, course: "21 рецепт", at: "2026-09-04T10:00:00Z", reviewText: "Поздравляю!" },
  ],
  system: { bot: true, instagram: true, storage: false, diskFreePct: 42, gemini: { calls: 850, limit: 1000 }, problems: [] },
};

const calls: { url: string; method: string; body?: unknown }[] = [];

function mockFetch(overrides: Partial<Today> = {}) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/admin/today")) {
        return new Response(JSON.stringify({ ...today, ...overrides }), { status: 200 });
      }
      if (url.includes("/reply")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes("/retranscode")) return new Response(JSON.stringify({ note: "Видео принято" }), { status: 200 });
      if (url.includes("/decide")) return new Response(JSON.stringify({ message: "Подтверждено" }), { status: 200 });
      return new Response(JSON.stringify({ error: "нет такого" }), { status: 404 });
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DashboardPage «Сегодня»", () => {
  beforeEach(() => mockFetch());

  it("рисует три утренних числа, дельты, спарклайн и очередь из ответа API", async () => {
    const onGo = vi.fn();
    render(<DashboardPage onGo={onGo} />);
    await screen.findByText("120 с.");

    const money = screen.getByTestId("tile-money");
    expect(within(money).getByText("+20%")).toBeTruthy(); // 120 против 100
    expect(within(money).getByText("+214%")).toBeTruthy(); // 220 против 70
    expect(screen.getByRole("button", { name: /вопрос без ответа/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /чек в ожидании/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Деньги за 14 дней/ })).toBeTruthy();

    const queue = screen.getByTestId("queue");
    expect(within(queue).getByText("@madina")).toBeTruthy();
    expect(within(queue).getByText("21 рецепт")).toBeTruthy();
    expect(within(queue).getByText("Можно молоко?")).toBeTruthy();
    expect(within(queue).getByText(/@nigora оплатила 3 дня назад/)).toBeTruthy();
    expect(within(queue).getByRole("link", { name: "Написать в Instagram" }).getAttribute("href")).toBe("https://www.instagram.com/nigora/");
    expect(within(queue).getByText(/Видео урока «Урок 7» не собралось/)).toBeTruthy();
    expect(within(queue).getByText(/Gemini на 85%/)).toBeTruthy();

    expect(screen.getByText("получила сертификат", { exact: false })).toBeTruthy();
    expect(screen.getByText("хранилище не настроено")).toBeTruthy();
    expect(screen.getByText("бот отвечает")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /вопрос без ответа/ }));
    expect(onGo).toHaveBeenCalledWith("questions");
  });

  it("пустая очередь — «Всё разобрано», а не пустое место", async () => {
    mockFetch({ queue: [], goodNews: [] });
    render(<DashboardPage onGo={vi.fn()} />);
    await screen.findByText(/Всё разобрано/);
    // Сцена AllDone (components/Illustration.tsx) — декоративная, текст рядом.
    expect(screen.getByTestId("empty-AllDone").querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(screen.queryByTestId("queue")).toBeNull();
  });

  it("ответ ученице прямо из карточки — POST reply, потом свежие данные (?fresh=1)", async () => {
    render(<DashboardPage onGo={vi.fn()} />);
    await screen.findByText("Можно молоко?");
    fireEvent.click(screen.getByRole("button", { name: "Ответить" }));
    fireEvent.change(screen.getByLabelText("Ответ для @zarina"), { target: { value: "Да, 3,2%" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    });
    const reply = calls.find((c) => c.url === "/admin/course-chat/q1/reply");
    expect(reply).toMatchObject({ method: "POST", body: { text: "Да, 3,2%" } });
    expect(calls.some((c) => c.url === "/admin/today?fresh=1")).toBe(true);
  });

  it("«Ещё раз» у битого видео зовёт retranscode", async () => {
    render(<DashboardPage onGo={vi.fn()} />);
    await screen.findByText(/Урок 7/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ещё раз" }));
    });
    expect(calls.find((c) => c.url === "/admin/lessons/l7/retranscode")?.method).toBe("POST");
  });

  it("подтверждение чека из очереди: карточка прячется сразу, запрос уходит через 5 с, «Отменить» его гасит", async () => {
    vi.useFakeTimers();
    try {
      render(
        <>
          <DashboardPage onGo={vi.fn()} />
          <ToastHost />
          <ChoiceHost />
        </>
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("receipt-r1")).toBeTruthy();

      await act(async () => {
        fireEvent.click(within(screen.getByTestId("receipt-r1")).getByRole("button", { name: "Подтвердить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      // Карточка «уезжает» (Collapse): сразу прячется от читалки, через
      // четверть секунды снимается с экрана совсем.
      expect(screen.getByTestId("receipt-r1").closest(".collapse")?.getAttribute("aria-hidden")).toBe("true");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.queryByTestId("receipt-r1")).toBeNull();
      expect(screen.getByText("Ссылка ушла @madina")).toBeTruthy();
      expect(calls.some((c) => c.url.includes("/decide"))).toBe(false);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(calls.some((c) => c.url.includes("/decide"))).toBe(false);
      // Карточка вернулась после свежего запроса.
      expect(screen.getByTestId("receipt-r1")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
