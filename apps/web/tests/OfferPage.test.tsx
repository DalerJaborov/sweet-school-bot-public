import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { OfferPage } from "../src/pages/OfferPage";
import { ConfirmHost } from "../src/components/ConfirmDialog";
import type { Offer, OfferSnapshot } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const offer: Offer = {
  prices: { course50: 50, course70: 70, bundle: 100 },
  offline: {
    price: 700,
    startDate: "",
    timeFrom: "13:40",
    timeTo: "16:30",
    address: "Душанбе, Водонасос, дом Додо Пицца",
    seats: null,
    days: 8,
    desserts: 21,
  },
};

const snapshot = (o: Offer, extra: Partial<OfferSnapshot> = {}): OfferSnapshot => ({
  offer: o,
  defaults: offer,
  today: "2026-11-08",
  warnings: o.offline.startDate ? [] : ["Дата набора не задана — клиентам скажем, что дата уточняется"],
  history: [],
  preview: {
    course50: { ru: `Арт-десерты — ${o.prices.course50} сомони`, tg: `Арт-десертҳо — ${o.prices.course50} сомонӣ` },
    course70: { ru: `21 рецепт — ${o.prices.course70} сомони`, tg: `21 навъи ширинӣ — ${o.prices.course70} сомонӣ` },
    bundle: { ru: `оба курса вместе — ${o.prices.bundle} сомони`, tg: `ҳар ду курс якҷоя — ${o.prices.bundle} сомонӣ` },
    offline: {
      ru: `💰 Стоимость: ${o.offline.price} сомони`,
      tg: `💰 Нарх: ${o.offline.price} сомонӣ`,
      source: "fields",
    },
  },
  ...extra,
});

type Call = { url: string; method: string; body?: { offer: Offer; confirm?: boolean } };

function mockApi(opts: { confirmFirst?: boolean } = {}) {
  const calls: Call[] = [];
  let current = offer;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined;
      calls.push({ url, method, body });
      if (url === "/admin/v1/offer" && method === "GET")
        return new Response(JSON.stringify(snapshot(current)), { status: 200 });
      if (url === "/admin/v1/offer/preview") {
        const o = body!.offer;
        return new Response(
          JSON.stringify({ preview: snapshot(o).preview, check: { errors: {}, confirm: [], warnings: [] } }),
          { status: 200 },
        );
      }
      if (url === "/admin/v1/offer" && method === "PUT") {
        if (opts.confirmFirst && !body?.confirm) {
          return new Response(
            JSON.stringify({
              error: "Цена меняется сильно — подтвердите",
              confirm: [{ field: "prices.course70", label: "21 рецепт, цена", before: 70, after: 7, percent: -90 }],
            }),
            { status: 409 },
          );
        }
        current = body!.offer;
        return new Response(JSON.stringify({ ok: true, changes: 1, ...snapshot(current) }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

describe("OfferPage «Цены и даты»", () => {
  it("один заголовок, карточки курсов, «Так скажет бот» RU и TG, дата не назначена — «уточняется»", async () => {
    mockApi();
    render(<OfferPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Цены и даты" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Арт-десерты — 50 сомони")).toBeTruthy();
    expect(screen.getByText("Арт-десертҳо — 50 сомонӣ")).toBeTruthy();
    expect(screen.getAllByText("Так скажет бот клиенту").length).toBe(4);
    expect(screen.getByText(/Не назначена — клиентам скажем «дата уточняется»/)).toBeTruthy();
    expect((screen.getByLabelText("Занятия с") as HTMLInputElement).value).toBe("13:40");
    expect((screen.getByLabelText("Десертов") as HTMLInputElement).value).toBe("21");
    expect((screen.getByRole("button", { name: "Всё сохранено" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("правка цены → живой предпросмотр бота; «Сохранить» шлёт PUT; подсказка про минуту", async () => {
    vi.useFakeTimers();
    const calls = mockApi();
    render(<OfferPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const [art] = screen.getAllByLabelText("Цена, сомони");
    fireEvent.change(art, { target: { value: "55" } });
    fireEvent.change(screen.getByLabelText("Ближайший набор"), { target: { value: "2026-12-01" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByText("Арт-десерты — 55 сомони")).toBeTruthy();
    expect(screen.getByText("1 декабря 2026 г.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body?.offer.prices.course50).toBe(55);
    expect(put?.body?.offer.offline.startDate).toBe("2026-12-01");
    expect(put?.body?.confirm).toBe(false);
    expect(screen.getByText("Бот подхватит сразу, на сайте появится в течение минуты.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Всё сохранено" })).toBeTruthy();
  });

  it("пустая цена — ошибка у поля, на сервер уходит null (не ноль)", async () => {
    vi.useFakeTimers();
    const calls = mockApi();
    render(<OfferPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getAllByLabelText("Цена, сомони")[1], { target: { value: "" } });
    expect(screen.getByText("Укажите цену — пустой оставить нельзя")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(calls.find((c) => c.url === "/admin/v1/offer/preview")?.body?.offer.prices.course70).toBeNull();
  });

  it("прошедшая дата — предупреждение «Набор в прошлом…»", async () => {
    mockApi();
    render(<OfferPage />);
    fireEvent.change(await screen.findByLabelText("Ближайший набор"), { target: { value: "2026-10-20" } });
    expect(screen.getByText("Набор в прошлом — клиентам скажем, что дата уточняется")).toBeTruthy();
  });

  it("цена меняется больше чем на 30 % — «Точно?», и только после «Да» уходит confirm", async () => {
    const calls = mockApi({ confirmFirst: true });
    render(
      <>
        <OfferPage />
        <ConfirmHost />
      </>,
    );
    fireEvent.change((await screen.findAllByLabelText("Цена, сомони"))[1], { target: { value: "7" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    expect(await screen.findByText("Точно меняем цену?")).toBeTruthy();
    expect(screen.getByText(/21 рецепт, цена: 70 → 7 сомони \(-90 %\)/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Да, сохранить" }));
    });
    await screen.findByRole("button", { name: "Всё сохранено" });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => p.body?.confirm)).toEqual([false, true]);
  });
});
