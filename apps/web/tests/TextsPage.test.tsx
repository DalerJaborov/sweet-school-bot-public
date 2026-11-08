import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TextsPage } from "../src/pages/TextsPage";
import type { TextsForm, TextsPreview } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form: TextsForm = {
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
  offline: { infoRu: "", infoTg: "" },
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
        return new Response(
          JSON.stringify({ ...preview, payment: { ru: `Перевод на ${body?.texts.paymentPhone}`, tg: "" } }),
          { status: 200 },
        );
      }
      if (url === "/admin/texts" && method === "PUT") {
        return new Response(
          JSON.stringify({
            ok: true,
            ...body,
            preview: { ...preview, payment: { ru: `сохранено: ${body?.texts.paymentPhone}`, tg: "" } },
          }),
          {
            status: 200,
          },
        );
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

describe("TextsPage «Тексты» — без цен и дат (они в «Цены и даты»)", () => {
  it("грузит форму с RU/TG рядом; полей цен и даты нет — только подсказка, куда идти", async () => {
    mockApi();
    render(<TextsPage />);
    expect(await screen.findByLabelText("Номер для перевода")).toBeTruthy();
    expect(screen.getAllByLabelText("По-русски").length).toBe(4);
    expect(screen.getAllByLabelText("Бо тоҷикӣ").length).toBe(4);
    expect(screen.queryByLabelText("Оба курса вместе")).toBeNull();
    expect(screen.queryByLabelText("Дата начала")).toBeNull();
    expect(screen.getByText(/Цены курсов и дата набора — в разделе «Цены и даты»/)).toBeTruthy();
    expect(screen.getByText(/Стоимость: 700 сомони/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Всё сохранено" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("правка реквизитов → живой предпросмотр; «Сохранить» шлёт PUT без цен", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockApi();
      render(<TextsPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByLabelText("Номер для перевода"), { target: { value: "900 111 222" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getByText(/Перевод на 900 111 222/)).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toEqual({
        texts: { ...form.texts, paymentPhone: "900 111 222" },
        offline: { infoRu: "", infoTg: "" },
      });
      expect(screen.getByText(/сохранено: 900 111 222/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
