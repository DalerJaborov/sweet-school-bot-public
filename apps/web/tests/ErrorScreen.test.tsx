import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorScreen } from "../src/course/screens/ErrorScreen";
import { dict } from "../src/course/i18n";

/**
 * Экран отказа — вход, а не тупик (ревью 05.09.2026): «Купить курс» и контакты
 * Ширин, а при умершей ссылке — WhatsApp уже с фразой «ссылка не открывается».
 */
const t = dict("ru");
const contacts = { telegram: "https://t.me/shirin", instagram: null, whatsapp: "https://wa.me/992905355355" };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => contacts });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ErrorScreen", () => {
  it("ГЛАВНОЕ: ссылка не действует — «Купить курс» и WhatsApp с готовым текстом", async () => {
    render(<ErrorScreen t={t} error={{ message: "Ссылка не действует", reason: "not_found" }} onRetry={() => undefined} />);

    const buy = screen.getByRole("link", { name: t.buyCourse });
    expect(buy.getAttribute("href")).toBe("https://shirinsweets.online/online-kurs");

    const wa = await screen.findByRole("link", { name: t.whatsapp });
    expect(wa.getAttribute("href")).toBe(`https://wa.me/992905355355?text=${encodeURIComponent(t.linkBrokenWa)}`);
    expect(screen.getByRole("link", { name: t.telegramGroup })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/course/contacts");
    expect(screen.getByText(t.help.not_found)).toBeTruthy();
  });

  it("нет сессии (пришли с сайта) — те же кнопки, WhatsApp без предзаполнения", async () => {
    render(<ErrorScreen t={t} error={{ message: "", reason: "no_session" }} onRetry={() => undefined} />);
    expect(screen.getByRole("link", { name: t.buyCourse })).toBeTruthy();
    const wa = await screen.findByRole("link", { name: t.whatsapp });
    expect(wa.getAttribute("href")).toBe("https://wa.me/992905355355");
  });

  it("контакты уже есть из /me — в сеть не ходим", () => {
    render(
      <ErrorScreen t={t} error={{ message: "x", reason: "revoked" }} onRetry={() => undefined} school={contacts} />,
    );
    expect(screen.getByRole("link", { name: t.whatsapp })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("сервер недоступен — «Купить курс» и «Попробовать снова» остаются", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<ErrorScreen t={t} error={{ message: "", reason: "network" }} onRetry={() => undefined} />);
    expect(screen.getByRole("link", { name: t.buyCourse })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.retry })).toBeTruthy();
    expect(screen.queryByRole("link", { name: t.whatsapp })).toBeNull();
  });

  it("по-таджикски — покупка ведёт на /tg/, текст WhatsApp таджикский", async () => {
    const tg = dict("tg");
    render(<ErrorScreen t={tg} error={{ message: "x", reason: "not_found" }} onRetry={() => undefined} />);
    expect(screen.getByRole("link", { name: tg.buyCourse }).getAttribute("href")).toContain("/tg/online-kurs");
    const wa = await screen.findByRole("link", { name: tg.whatsapp });
    expect(wa.getAttribute("href")).toContain(encodeURIComponent(tg.linkBrokenWa));
  });
});
