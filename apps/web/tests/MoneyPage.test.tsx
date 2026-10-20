import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MoneyPage, hoursLabel } from "../src/pages/MoneyPage";
import type { FunnelResponse, RevenueResponse } from "../src/api";

/**
 * «Деньги» v2: плитки каналов и срока до оплаты, столбики по каналам/курсам и
 * воронка рисуются из /admin/metrics/revenue и /admin/metrics/funnel; сбой
 * этих двух запросов не прячет главные суммы из /admin/money.
 */
const money = {
  days: 30,
  total: 190,
  count: 3,
  byCourse: { COURSE70: { count: 2, sum: 140 }, COURSE50: { count: 1, sum: 50 } },
  byDay: { "2026-09-03": 70, "2026-09-04": 120 },
  revoked: 0,
  pending: 0,
  unchecked: 0,
  blocked: 0,
  offline: 1,
  rows: [{ id: "p1", who: "@madina", course: "COURSE70", amount: 70, joined: true, createdAt: "2026-09-04T10:00:00Z" }],
  hasMore: false,
};

const revenue: RevenueResponse = {
  days: 30,
  total: 190,
  count: 3,
  byCourse: [
    { key: "COURSE70", title: "21 рецепт", count: 2, sum: 140 },
    { key: "COURSE50", title: "Арт-десерты", count: 1, sum: 50 },
  ],
  byChannel: [
    { key: "INSTAGRAM", title: "Instagram", count: 2, sum: 120 },
    { key: "WEB", title: "сайт", count: 1, sum: 70 },
  ],
  timeToPay: { medianHours: 6, averageHours: 30, sample: 3 },
};

const funnel: FunnelResponse = {
  days: 30,
  steps: [
    { key: "wrote", title: "написали", count: 100, conversion: null },
    { key: "funnel", title: "прошли воронку", count: 40, conversion: 40 },
    { key: "receipt", title: "прислали чек", count: 10, conversion: 25 },
    { key: "paid", title: "оплатили", count: 8, conversion: 80 },
    { key: "opened", title: "открыли урок 1", count: 6, conversion: 75 },
    { key: "finished", title: "досмотрели всё", count: 2, conversion: 33 },
    { key: "certificate", title: "сертификат", count: 1, conversion: 50 },
  ],
};

function mockFetch(opts: { metricsFail?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("/admin/money")) return new Response(JSON.stringify(money), { status: 200 });
      if (opts.metricsFail) return new Response(JSON.stringify({ error: "упало" }), { status: 500 });
      if (url.startsWith("/admin/metrics/revenue")) return new Response(JSON.stringify(revenue), { status: 200 });
      if (url.startsWith("/admin/metrics/funnel")) return new Response(JSON.stringify(funnel), { status: 200 });
      return new Response(JSON.stringify({ error: "нет такого" }), { status: 404 });
    })
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MoneyPage: каналы, срок до оплаты, воронка", () => {
  it("рисует плитки каналов, медиану срока до оплаты, столбики и 7 ступеней воронки", async () => {
    const calls = mockFetch();
    render(<MoneyPage />);
    await screen.findByText("190 с.");

    const channels = await screen.findByTestId("revenue-channels");
    expect(within(channels).getByText("120 с.", { selector: ".tile-value" })).toBeTruthy();
    expect(within(channels).getByText(/Instagram · 2 продажи/)).toBeTruthy();
    expect(within(channels).getByText(/сайт · 1 продажа/)).toBeTruthy();
    expect(within(channels).getByText("6 часов")).toBeTruthy();
    expect(within(channels).getByText(/в среднем 30 часов/)).toBeTruthy();
    expect(within(channels).getByRole("img", { name: /Выручка по каналам: Instagram 120 с., сайт 70 с./ })).toBeTruthy();
    expect(within(channels).getByRole("img", { name: /Выручка по курсам: 21 рецепт 140 с./ })).toBeTruthy();

    const f = screen.getByTestId("funnel");
    expect(within(f).getByText("Воронка за 30 дней")).toBeTruthy();
    expect(within(f).getAllByRole("listitem")).toHaveLength(7);
    expect(within(f).getByText("написали")).toBeTruthy();
    expect(within(f).getByText("100")).toBeTruthy();
    expect(within(f).getByText("40% от предыдущего шага")).toBeTruthy();
    expect(within(f).queryByText(/null/)).toBeNull();

    // Все три запроса — за тот же период.
    expect(calls).toEqual(expect.arrayContaining(["/admin/money?days=30", "/admin/metrics/revenue?days=30", "/admin/metrics/funnel?days=30"]));
  });

  it("сбой metrics не прячет суммы из /admin/money", async () => {
    mockFetch({ metricsFail: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<MoneyPage />);
    await screen.findByText("190 с.");
    expect(screen.queryByTestId("revenue-channels")).toBeNull();
    expect(screen.queryByTestId("funnel")).toBeNull();
    expect(screen.queryByText(/упало/)).toBeNull();
  });

  it("hoursLabel — минуты, часы, дни", () => {
    expect(hoursLabel(0.3)).toBe("18 мин");
    expect(hoursLabel(1)).toBe("1 час");
    expect(hoursLabel(22.4)).toBe("22 часа");
    expect(hoursLabel(72)).toBe("3 дня");
  });
});
