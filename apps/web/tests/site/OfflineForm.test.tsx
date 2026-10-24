import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { OfflineForm, validateName, validatePhone } from "../../src/site/OfflineForm";
import { resetCatalogCache } from "../../src/site/catalog";
import { dict } from "../../src/site/i18n";

const catalog = {
  courses: [],
  bundle: null,
  offline: { price: 750, currency: "TJS", nextStartDate: "2026-09-15", info: null },
  contacts: { phone: "", whatsapp: "", telegram: "", instagram: "", tiktok: "" },
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("OfflineForm", () => {
  beforeEach(() => resetCatalogCache());
  afterEach(cleanup);

  it("валидация имени и телефона как в контракте", () => {
    expect(validateName("М")).toBe(false);
    expect(validateName("Мадина")).toBe(true);
    expect(validatePhone("12345")).toBe(false);
    expect(validatePhone("+992 905 355 355")).toBe(true);
    expect(validatePhone("abc905355355")).toBe(false);
    expect(validatePhone("+992 (90) 535-53-55")).toBe(true);
    expect(validatePhone("+++905355355")).toBe(false);
    expect(validatePhone("1234567890123456")).toBe(false);
  });

  it("не отправляет пустую форму, показывает ошибки полей", async () => {
    const fetchMock = mockFetch(() => json(catalog));
    render(<OfflineForm t={dict("ru")} lang="ru" priceFallback={700} />);
    fireEvent.click(screen.getByText("Записаться"));
    expect(screen.getByText(dict("ru").formErrName)).toBeTruthy();
    expect(screen.getByText(dict("ru").formErrPhone)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // только каталог
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("offline-signup"))).toBe(false);
  });

  it("цена из API (fallback 700 до загрузки), успешная заявка → состояние «отправлено»", async () => {
    const fetchMock = mockFetch((url) => (String(url).includes("/courses") ? json(catalog) : json({ ok: true })));
    render(<OfflineForm t={dict("ru")} lang="ru" priceFallback={700} />);
    expect(screen.getByTestId("offline-price").textContent).toContain("700 сомони");
    await waitFor(() => expect(screen.getByTestId("offline-price").textContent).toContain("750 сомони"));
    // Дата из API — в тех же словах и падеже, что у бота («3 октября»), без «Ближайшая группа».
    expect(screen.getByTestId("offline-next-start").textContent).toBe("Ближайший набор: 15 сентября");
    expect(screen.queryByTestId("offline-date-tbd")).toBeNull();

    fireEvent.change(screen.getByLabelText("Ваше имя"), { target: { value: "Мадина" } });
    fireEvent.change(screen.getByLabelText("Телефон"), { target: { value: "+992 905 355 355" } });
    fireEvent.click(screen.getByText("Записаться"));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByText("Мадина, спасибо! Ширин свяжется с вами в ближайшее время.")).toBeTruthy();

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("offline-signup"))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ name: "Мадина", phone: "+992 905 355 355", lang: "ru" });
  });

  it("nextStartDate: null (набор прошёл или не назначен) → «дата уточняется», без даты; до загрузки — ничего", async () => {
    mockFetch(() => json({ ...catalog, offline: { ...catalog.offline, nextStartDate: null } }));
    render(<OfflineForm t={dict("tg")} lang="tg" priceFallback={700} />);
    expect(screen.queryByTestId("offline-date-tbd")).toBeNull();
    expect(screen.queryByTestId("offline-next-start")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("offline-date-tbd").textContent).toBe(dict("tg").offlineDateTbd));
    expect(screen.queryByTestId("offline-next-start")).toBeNull();
  });

  it("дата форматируется как у бота на обоих языках", () => {
    expect(dict("ru").dayMonth("2026-10-03")).toBe("3 октября");
    expect(dict("tg").dayMonth("2026-10-03")).toBe("3 октябр");
    expect(dict("ru").dayMonth("мусор")).toBe("мусор");
  });

  it("429 → подсказка про лимит", async () => {
    mockFetch((url) =>
      String(url).includes("/courses") ? json(catalog) : json({ error: "limit", retryAfterSec: 3600 }, 429),
    );
    render(<OfflineForm t={dict("tg")} lang="tg" priceFallback={700} />);
    fireEvent.change(screen.getByLabelText(dict("tg").formName), { target: { value: "Мадина" } });
    fireEvent.change(screen.getByLabelText(dict("tg").formPhone), { target: { value: "905355355" } });
    fireEvent.click(screen.getByText(dict("tg").formSubmit));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dict("tg").formErrLimit));
  });
});
