import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DeviceLimitScreen } from "../src/course/screens/DeviceLimitScreen";
import { dict, formatLastSeen } from "../src/course/i18n";
import type { DeviceLimitState } from "../src/course/hooks/useCourse";

const t = dict("ru");
const DAY = 86_400_000;

function limit(over: Partial<DeviceLimitState> = {}): DeviceLimitState {
  return {
    devices: [{ id: "d1", label: "Android", city: "Душанбе", lastSeenAt: new Date(Date.now() - DAY).toISOString(), blocked: false }],
    phone: "SM-A515F",
    school: null,
    ...over,
  };
}

afterEach(cleanup);

/**
 * Второй телефон (владелец 08.11.2026): кнопки «Перенести» и ввода кода нет,
 * экран говорит, на каком телефоне курс открыт, и ведёт к покупке для другого.
 */
describe("DeviceLimitScreen", () => {
  it("ГЛАВНОЕ: называет модель занятого телефона и ведёт на покупку #kupit", () => {
    render(<DeviceLimitScreen t={t} limit={limit()} />);
    expect(screen.getByText(t.deviceLimitTitle)).toBeTruthy();
    expect(
      screen.getByText("Этот курс открывается на телефоне SM-A515F. Чтобы смотреть на другом телефоне, купите курс для него."),
    ).toBeTruthy();
    const buy = screen.getByRole("link", { name: t.deviceLimitBuy }) as HTMLAnchorElement;
    expect(buy.getAttribute("href")).toBe("https://shirinsweets.online/online-kurs#kupit");
  });

  it("iPhone — подпись «iPhone»; модель неизвестна — «вашем основном телефоне»", () => {
    const { rerender } = render(<DeviceLimitScreen t={t} limit={limit({ phone: "iPhone" })} />);
    expect(screen.getByText(/на телефоне iPhone\./)).toBeTruthy();
    rerender(<DeviceLimitScreen t={t} limit={limit({ phone: null })} />);
    expect(screen.getByText(/на вашем основном телефоне\./)).toBeTruthy();
  });

  it("кнопок переноса и поля кода нет; есть подсказка про смену телефона через чат", () => {
    render(<DeviceLimitScreen t={t} limit={limit()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/код/i)).toBeNull();
    expect(screen.getByText(/сменила телефон/)).toBeTruthy();
  });

  it("на таджикском текст, кнопка и ссылка ведут на таджикскую страницу", () => {
    const tg = dict("tg");
    render(<DeviceLimitScreen t={tg} limit={limit({ phone: null })} />);
    expect(screen.getByText(/телефони асосии шумо/)).toBeTruthy();
    const buy = screen.getByRole("link", { name: tg.deviceLimitBuy }) as HTMLAnchorElement;
    expect(buy.getAttribute("href")).toBe("https://shirinsweets.online/tg/online-kurs#kupit");
  });

  it("контакты школы показываются, если известны", () => {
    render(<DeviceLimitScreen t={t} limit={limit({ school: { telegram: "https://t.me/x", instagram: null, whatsapp: null } })} />);
    expect(screen.getByRole("link", { name: t.telegramGroup })).toBeTruthy();
  });
});

describe("formatLastSeen", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  it("сегодня / вчера / N дней назад / дата", () => {
    expect(formatLastSeen("2026-09-03T08:00:00Z", t, now)).toBe("сегодня");
    expect(formatLastSeen("2026-09-02T08:00:00Z", t, now)).toBe("вчера");
    expect(formatLastSeen("2026-08-31T08:00:00Z", t, now)).toBe("3 дня назад");
    expect(formatLastSeen("2026-08-01T08:00:00Z", t, now)).toBe(
      new Date("2026-08-01T08:00:00Z").toLocaleDateString("ru-RU"),
    );
    expect(formatLastSeen(null, t, now)).toBe("");
  });
});
