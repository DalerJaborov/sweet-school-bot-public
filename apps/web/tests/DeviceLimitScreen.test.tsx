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
 * Второй телефон (владелец 08.11.2026): кнопок «Перенести» и «Купить» и поля кода
 * нет; экран говорит про отдельный доступ и отправляет к боту.
 */
describe("DeviceLimitScreen", () => {
  it("ГЛАВНОЕ: «нужен отдельный доступ на другой аккаунт или номер, напишите Ширин» и «напишите боту»", () => {
    render(<DeviceLimitScreen t={t} limit={limit()} />);
    expect(screen.getByText(t.deviceLimitTitle)).toBeTruthy();
    expect(
      screen.getByText("Для второго телефона нужен отдельный доступ, он оформляется на другой аккаунт или номер, напишите Ширин."),
    ).toBeTruthy();
    expect(screen.getByText("Если это ваш телефон, напишите боту, он проверит и откроет.")).toBeTruthy();
  });

  it("не обещает «купите курс для этого телефона», нет кнопок и поля кода, нет цифр про лимит", () => {
    const { container } = render(<DeviceLimitScreen t={t} limit={limit()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/код/i)).toBeNull();
    expect(container.textContent).not.toMatch(/купите курс|30|#kupit/);
    expect(container.querySelector("a[href*='kupit']")).toBeNull();
  });

  it("на таджикском тот же смысл", () => {
    const tg = dict("tg");
    render(<DeviceLimitScreen t={tg} limit={limit({ phone: null })} />);
    expect(screen.getByText(/дастрасии алоҳида лозим аст/)).toBeTruthy();
    expect(screen.getByText(/ба бот нависед/)).toBeTruthy();
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
