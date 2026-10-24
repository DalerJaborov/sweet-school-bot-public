import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { CoursesIsland } from "../../src/site/CoursesIsland";
import { resetCatalogCache } from "../../src/site/catalog";
import { dict } from "../../src/site/i18n";
import { displayTitle } from "../../src/site/api";
import { whatsappOrderUrl } from "../../src/site/sales";

const catalog = {
  courses: [
    {
      code: "COURSE50",
      title: "Арт-десерты (50 сомони)",
      description: "Десерты",
      price: 50,
      currency: "TJS",
      coverUrl: null,
      lessonsCount: 12,
      durationMin: 180,
    },
    {
      code: "COURSE70",
      title: "Торты",
      description: null,
      price: 70,
      currency: "TJS",
      coverUrl: "https://x/c.jpg",
      lessonsCount: 9,
      durationMin: 120,
    },
  ],
  bundle: { price: 100, fullPrice: 120 },
  offline: { price: 700, currency: "TJS", nextStartDate: null, info: null },
  contacts: {
    phone: "",
    whatsapp: "https://api.whatsapp.com/send?phone=992905355355",
    telegram: "",
    instagram: "",
    tiktok: "",
  },
};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
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
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/site/courses",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(screen.queryByText(/\(50 сомони\)/)).toBeNull();
    expect(screen.getByText("50 сомони")).toBeTruthy();
    expect(screen.getByText("70 сомони")).toBeTruthy();
    expect(screen.getByText("12 видеоуроков")).toBeTruthy();
    expect(screen.getByText(/выгода 20 сомони/)).toBeTruthy();
    expect(screen.getByAltText("Обложка курса «Торты»")).toBeTruthy();
  });

  it("покупка идёт человеку в WhatsApp с актуальной ценой и составом, без приёма чека", async () => {
    mockFetch(catalog);
    render(<CoursesIsland t={dict("ru")} />);
    await waitFor(() => screen.getByText("Арт-десерты"));
    const link = screen.getByRole("link", { name: "Купить курс «Арт-десерты» в WhatsApp" });
    const url = new URL(link.getAttribute("href")!);
    expect(url.hostname).toBe("api.whatsapp.com");
    expect(url.searchParams.get("phone")).toBe("992905355355");
    expect(url.searchParams.get("text")).toContain("Арт-десерты");
    expect(url.searchParams.get("text")).toContain("50 сомони");
    const bundleLink = screen.getAllByRole("link").at(-1)!;
    expect(new URL(bundleLink.getAttribute("href")!).searchParams.get("text")).toContain("100 сомони");
    expect(screen.getByText(/После ручной проверки оплаты/)).toBeTruthy();
    expect(screen.queryByLabelText(/Прикрепить чек/)).toBeNull();
  });

  it("ошибка сети → сообщение и повтор", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    render(<CoursesIsland t={dict("tg")} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    mockFetch(catalog);
    fireEvent.click(screen.getByText(dict("tg").retry));
    await waitFor(() => expect(screen.getByText("Арт-десертҳо")).toBeTruthy());
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

  it("TG каталог и заказ используют таджикские названия и текущую новую цену", async () => {
    mockFetch({ ...catalog, courses: [{ ...catalog.courses[0], price: 85, durationMin: 17 }], bundle: null });
    render(<CoursesIsland t={dict("tg")} />);
    await waitFor(() => expect(screen.getByText("Арт-десертҳо")).toBeTruthy());
    const order = screen.getByRole("link", { name: /Арт-десертҳо/ });
    const text = new URL(order.getAttribute("href")!).searchParams.get("text");
    expect(text).toContain("85 сомонӣ");
    expect(text).toContain("Мехоҳам");
    expect(screen.getByText("17 дақиқа видео")).toBeTruthy();
    expect(screen.queryByText("Десерты")).toBeNull();
  });

  it("public catalogue cannot redirect a purchase to an untrusted host", () => {
    const url = new URL(whatsappOrderUrl("https://example.com/steal", "order & amount"));
    expect(url.hostname).toBe("api.whatsapp.com");
    expect(url.searchParams.get("text")).toBe("order & amount");
  });
});
