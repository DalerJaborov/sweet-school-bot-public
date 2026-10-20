import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { CoursesIsland } from "../../src/site/CoursesIsland";
import { resetCatalogCache } from "../../src/site/catalog";
import { dict } from "../../src/site/i18n";
import { CHAT_OPEN_EVENT } from "../../src/site/chat/bus";
import { displayTitle } from "../../src/site/api";

const catalog = {
  courses: [
    { code: "COURSE50", title: "Арт-десерты (50 сомони)", description: "Десерты", price: 50, currency: "TJS", coverUrl: null, lessonsCount: 12, durationMin: 180 },
    { code: "COURSE70", title: "Торты", description: null, price: 70, currency: "TJS", coverUrl: "https://x/c.jpg", lessonsCount: 9, durationMin: 120 },
  ],
  bundle: { price: 100, fullPrice: 120 },
  offline: { price: 700, currency: "TJS", nextStartDate: null, info: null },
  contacts: { phone: "", whatsapp: "", telegram: "", instagram: "", tiktok: "" },
};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("CoursesIsland", () => {
  beforeEach(() => resetCatalogCache());
  afterEach(cleanup);

  it("скелет → карточки из API, цена не удваивается, набор — из bundle", async () => {
    const fetchMock = mockFetch(catalog);
    render(<CoursesIsland t={dict("ru")} />);
    expect(screen.getByTestId("courses-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Арт-десерты")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/site/courses", expect.objectContaining({ credentials: "same-origin" }));
    expect(screen.queryByText(/\(50 сомони\)/)).toBeNull();
    expect(screen.getByText("50 сомони")).toBeTruthy();
    expect(screen.getByText("70 сомони")).toBeTruthy();
    expect(screen.getByText("12 видеоуроков")).toBeTruthy();
    expect(screen.getByText(/выгода 20 сомони/)).toBeTruthy();
    expect(screen.getByAltText("Обложка курса «Торты»")).toBeTruthy();
  });

  it("кнопка «Купить» открывает чат с названием курса", async () => {
    mockFetch(catalog);
    const opened = vi.fn();
    window.addEventListener(CHAT_OPEN_EVENT, (e) => opened((e as CustomEvent).detail));
    render(<CoursesIsland t={dict("ru")} />);
    await waitFor(() => screen.getByText("Арт-десерты"));
    fireEvent.click(screen.getByLabelText("Купить курс «Арт-десерты» через чат"));
    expect(opened).toHaveBeenCalledWith({ prefill: "Здравствуйте! Хочу купить онлайн-курс «Арт-десерты»." });
  });

  it("ошибка сети → сообщение и повтор", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<CoursesIsland t={dict("tg")} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    mockFetch(catalog);
    fireEvent.click(screen.getByText(dict("tg").retry));
    await waitFor(() => expect(screen.getByText("Арт-десерты")).toBeTruthy());
  });

  it("only=код — только эта карточка курса, без связки и без второго курса", async () => {
    mockFetch(catalog);
    render(<CoursesIsland t={dict("ru")} only="COURSE50" />);
    await waitFor(() => expect(screen.getByText("Арт-десерты")).toBeTruthy());
    expect(screen.queryByText("Торты")).toBeNull();
    expect(screen.queryByText(/выгода/)).toBeNull();
  });

  it("displayTitle отрезает хвост с ценой", () => {
    expect(displayTitle("Арт-десерты (50 сомони)")).toBe("Арт-десерты");
    expect(displayTitle("Торты (70 TJS)")).toBe("Торты");
    expect(displayTitle("Торты (новинка)")).toBe("Торты (новинка)");
  });
});
