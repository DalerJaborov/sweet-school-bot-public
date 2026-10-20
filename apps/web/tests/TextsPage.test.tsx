import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TextsPage } from "../src/pages/TextsPage";
import type { TextsForm, TextsPreview } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form: TextsForm = {
  prices: { course50: 50, course70: 70, bundle: 100 },
  texts: {
    paymentPhone: "905 355 355",
    paymentRecipient: "Чаборова Фарангис",
    paymentBanks: "Душанбе Сити, Алиф",
    paymentNameNoteRu: "Карта на Фарангис",
    paymentNameNoteTg: "Корт ба номи Фарангис",
    certificateRuleRu: "Когда все уроки просмотрены",
    certificateRuleTg: "Вақте ҳамаи дарсҳо тамошо шуданд",
    lessonLanguageRu: "Ширин говорит по-таджикски",
    lessonLanguageTg: "Ширин бо тоҷикӣ гап мезанад",
    afterPaymentRu: "Пришлите чек",
    afterPaymentTg: "Чекро фиристед",
  },
  offline: { price: 700, days: 8, hours: "14:00 до 17:00", desserts: 20, address: "Рудаки 156а", startDate: "", infoRu: "", infoTg: "" },
};

const preview: TextsPreview = {
  priceLine: "Арт-десерты — 50 сомони, 21 рецепт — 70 сомони, оба курса вместе — 100 сомони",
  priceList: [],
  payment: { ru: "Перевод через Алиф", tg: "Интиқол" },
  certificate: { ru: "Когда все уроки просмотрены", tg: "Вақте" },
  lessonLanguage: { ru: "Ширин говорит по-таджикски", tg: "Ширин" },
  afterPayment: { ru: "Пришлите чек", tg: "Чекро фиристед" },
  offlineCard: { ru: "🍰 Офлайн-курс в Душанбе\n💰 Стоимость: 700 сомони", tg: "🍰 Курси офлайнӣ" },
  botRules: "НЕЗЫБЛЕМЫЕ ПРАВИЛА",
};

function mockApi() {
  const calls: { url: string; method: string; body?: TextsForm }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as TextsForm) : undefined;
      calls.push({ url, method, body });
      if (url === "/admin/texts" && method === "GET") {
        return new Response(JSON.stringify({ ...form, defaults: form, preview }), { status: 200 });
      }
      if (url === "/admin/texts/preview") {
        return new Response(JSON.stringify({ ...preview, priceLine: `оба курса вместе — ${body?.prices.bundle} сомони` }), { status: 200 });
      }
      if (url === "/admin/texts" && method === "PUT") {
        return new Response(
          JSON.stringify({ ok: true, ...body, preview: { ...preview, priceLine: `сохранено: комплект ${body?.prices.bundle}` } }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    })
  );
  return calls;
}

describe("TextsPage «Тексты и цены»", () => {
  it("грузит форму с RU/TG рядом и предпросмотром; кнопка неактивна, пока ничего не менялось", async () => {
    mockApi();
    render(<TextsPage />);
    const bundle = (await screen.findByLabelText("Оба курса вместе")) as HTMLInputElement;
    expect(bundle.value).toBe("100");
    expect(screen.getByLabelText("Номер для перевода")).toBeTruthy();
    expect(screen.getAllByLabelText("По-русски").length).toBe(4);
    expect(screen.getAllByLabelText("Бо тоҷикӣ").length).toBe(4);
    expect(screen.getByText(preview.priceLine)).toBeTruthy();
    expect(screen.getByText(/Стоимость: 700 сомони/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Всё сохранено" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("правка цены → живой предпросмотр с сервера; «Сохранить» шлёт PUT со всей формой", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockApi();
      render(<TextsPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByLabelText("Оба курса вместе"), { target: { value: "110" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(calls.find((c) => c.url === "/admin/texts/preview")?.body?.prices.bundle).toBe(110);
      expect(screen.getByText("оба курса вместе — 110 сомони")).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Адрес"), { target: { value: "Айни 10" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({
        prices: { course50: 50, course70: 70, bundle: 110 },
        texts: { paymentPhone: "905 355 355" },
        offline: { address: "Айни 10", price: 700 },
      });
      expect(screen.getByText("сохранено: комплект 110")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Всё сохранено" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
