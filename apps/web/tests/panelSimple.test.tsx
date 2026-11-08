import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TodayPage } from "../src/pages/TodayPage";
import { MorePage } from "../src/pages/MorePage";
import { Switch } from "../src/components/Switch";
import { InstallSteps } from "../src/components/InstallApp";
import { activeCards, type Attention } from "../src/panel/useAttention";
import { BOTTOM_NAV, MORE_SECTIONS, bottomNavFor, isAllowed, navOwner } from "../src/panel/nav";
import { setSimpleMode, isSimpleMode, setTheme, currentTheme, applyTheme } from "../src/panel/prefs";
import { detectPlatform } from "../src/panel/pwa";

afterEach(() => {
  cleanup();
  setSimpleMode(false);
  setTheme("light");
});

const empty: Attention = { receipts: 0, questions: 0, notOpened: 0, waiting: [], queue: [], problems: [] };
const busy: Attention = {
  receipts: 2,
  questions: 1,
  notOpened: 0,
  waiting: [
    { contactId: "w1", name: "@demo", channel: "INSTAGRAM", channelLabel: "Instagram", replyUrl: "https://www.instagram.com/demo/", lastText: "Позовите Ширин", at: new Date().toISOString() },
    { contactId: "w2", name: "Без ссылки", channel: "WEB", channelLabel: "Сайт", replyUrl: null, lastText: "Здравствуйте", at: new Date().toISOString() },
  ],
  queue: [
    { kind: "receipt", id: "r1", who: { contactId: "c1", handle: "@demo", instagramUrl: null, channel: "INSTAGRAM" }, imageUrl: null, amount: 70, courseGuess: null, reason: "", confidence: 60, createdAt: new Date().toISOString() },
    { kind: "recipesToReview", count: 4 },
  ],
  problems: ["база не отвечает"],
};

function today(data: Attention | null, over: Partial<Parameters<typeof TodayPage>[0]> = {}) {
  const props = { data, error: null, simple: false, onRetry: vi.fn(), onGo: vi.fn(), onOpenStudent: vi.fn(), ...over };
  render(<TodayPage {...props} />);
  return props;
}

describe("Сегодня", () => {
  it("нет данных — скелетон, а не «всё сделано»", () => {
    today(null);
    expect(screen.getByTestId("today-skeleton")).toBeTruthy();
    expect(screen.queryByText("Всё сделано")).toBeNull();
  });

  it("нет дел — спокойное «Всё сделано»", () => {
    today(empty);
    expect(screen.getByText("Всё сделано")).toBeTruthy();
  });

  it("ошибка без данных — «Ещё раз», а не пустота", () => {
    const p = today(null, { error: "Failed to fetch" });
    fireEvent.click(screen.getByText("Ещё раз"));
    expect(p.onRetry).toHaveBeenCalled();
  });

  it("у каждого дела одна понятная кнопка-действие", () => {
    const p = today(busy);
    fireEvent.click(screen.getByText("Проверить чеки"));
    expect(p.onGo).toHaveBeenCalledWith("receipts");
    fireEvent.click(screen.getByText("Ответить", { selector: "button" }));
    expect(p.onGo).toHaveBeenCalledWith("questions");
    const link = screen.getByLabelText("Ответить: @demo") as HTMLAnchorElement;
    expect(link.href).toBe("https://www.instagram.com/demo/");
    fireEvent.click(screen.getByLabelText("Открыть переписку: Без ссылки"));
    expect(p.onOpenStudent).toHaveBeenCalledWith("w2");
  });

  it("активные карточки: в режиме сестры нет технических", () => {
    expect(activeCards(busy, false)).toEqual(["receipts", "waiting", "questions", "recipes", "problems"]);
    expect(activeCards(busy, true)).toEqual(["receipts", "waiting", "questions"]);
    expect(activeCards(empty, false)).toEqual([]);
  });
});

describe("Навигация и режим сестры", () => {
  it("внизу пять пунктов; у сестры — только Сегодня, Чеки, Клиенты, Ещё", () => {
    expect(BOTTOM_NAV.map((b) => b.label)).toEqual(["Сегодня", "Чеки", "Клиенты", "Курсы и цены", "Ещё"]);
    expect(bottomNavFor(true).map((b) => b.id)).toEqual(["home", "receipts", "clients", "more"]);
    expect(isAllowed("settings", true)).toBe(false);
    expect(isAllowed("questions", true)).toBe(true);
  });

  it("каждый раздел «Ещё» подсвечивает «Ещё», редкие спрятаны в «Для опытных»", () => {
    for (const s of MORE_SECTIONS) expect(navOwner(s.id)).toBe("more");
    const expert = MORE_SECTIONS.filter((s) => s.group === "expert").map((s) => s.id);
    expect(expert).toEqual(expect.arrayContaining(["quality", "style", "import", "media", "funnels"]));
    expect(navOwner("texts")).toBe("courses");
  });

  it("в видимых названиях нет жаргона", () => {
    const words = [...MORE_SECTIONS, ...BOTTOM_NAV].map((s) => ("about" in s ? `${s.label} ${s.about}` : s.label)).join(" ").toLowerCase();
    for (const bad of ["воронк", "лид", "слот", "api", "токен", "вебхук"]) expect(words).not.toContain(bad);
  });

  it("тумблер режима сестры меняется сразу и прячет разделы", () => {
    render(<MorePage onGo={vi.fn()} onLogout={vi.fn()} />);
    expect(screen.getByText("Деньги")).toBeTruthy();
    fireEvent.click(screen.getByTestId("switch-simple"));
    expect(isSimpleMode()).toBe(true);
    expect((screen.getByTestId("switch-simple") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Деньги")).toBeNull();
    expect(screen.queryByText("Для опытных")).toBeNull();
  });

  it("тёмный вид красит страницу и запоминается", () => {
    render(<MorePage onGo={vi.fn()} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByTestId("switch-dark"));
    expect(currentTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => setTheme("light"));
    applyTheme();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("Switch и установка", () => {
  it("Switch — настоящий выключатель, не блокируется после нажатия", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Помощник" />);
    const sw = screen.getByRole("switch") as HTMLInputElement;
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.disabled).toBe(false);
  });

  it("инструкции: iPhone — Поделиться → На экран «Домой»; Android — меню Chrome", () => {
    render(<InstallSteps platform="ios" />);
    expect(screen.getByText(/Поделиться/)).toBeTruthy();
    expect(screen.getByText(/На экран “Домой”/)).toBeTruthy();
    cleanup();
    render(<InstallSteps platform="android" />);
    expect(screen.getByText(/Установить приложение/)).toBeTruthy();
  });

  it("платформа определяется по устройству", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0)")).toBe("other");
  });
});
