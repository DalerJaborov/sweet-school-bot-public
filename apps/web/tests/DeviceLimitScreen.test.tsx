import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DeviceLimitScreen } from "../src/course/screens/DeviceLimitScreen";
import { dict, formatLastSeen } from "../src/course/i18n";
import type { DeviceLimitState } from "../src/course/hooks/useCourse";

const t = dict("ru");
const DAY = 86_400_000;

function limit(over: Partial<DeviceLimitState> = {}): DeviceLimitState {
  return {
    devices: [
      {
        id: "d1",
        label: "iPhone",
        city: "Душанбе",
        lastSeenAt: new Date(Date.now() - DAY).toISOString(),
        blocked: false,
      },
      {
        id: "d2",
        label: "Компьютер",
        city: null,
        lastSeenAt: new Date(Date.now() - 30 * DAY).toISOString(),
        blocked: true,
      },
    ],
    swapsLeft: 1,
    school: null,
    busy: false,
    ...over,
  };
}

afterEach(cleanup);

/**
 * Лимит устройств (дизайн доступа 03.09.2026): вместо тупика «напишите нам» —
 * список занятого и кнопка «заменить самое старое», пока замены есть.
 */
describe("DeviceLimitScreen", () => {
  it("перечисляет устройства: подпись, город, «вчера», значок блокировки", () => {
    render(<DeviceLimitScreen t={t} limit={limit()} onReplace={() => undefined} />);
    expect(screen.getByText("iPhone · Душанбе")).toBeTruthy();
    expect(screen.getByText("Компьютер")).toBeTruthy();
    expect(screen.getByText("в сети вчера")).toBeTruthy();
    expect(screen.getByText("заблокировано")).toBeTruthy();
  });

  it("ГЛАВНОЕ: «заменить самое старое» зовёт /open с replaceOldest, пока замены есть", () => {
    const onReplace = vi.fn();
    render(<DeviceLimitScreen t={t} limit={limit()} onReplace={onReplace} />);
    fireEvent.click(screen.getByRole("button", { name: t.replaceOldest }));
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Осталось замен: 1")).toBeTruthy();
  });

  it("пока запрос идёт — кнопка выключена, чтобы не заменить дважды", () => {
    render(<DeviceLimitScreen t={t} limit={limit({ busy: true })} onReplace={() => undefined} />);
    expect((screen.getByRole("button", { name: t.replaceOldest }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("замены кончились — кнопки нет, есть «напишите нам» и контакты школы", () => {
    render(
      <DeviceLimitScreen
        t={t}
        limit={limit({ swapsLeft: 0, school: { telegram: "https://t.me/x", instagram: null, whatsapp: null } })}
        onReplace={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: t.replaceOldest })).toBeNull();
    expect(screen.getByText(t.noSwapsLeft)).toBeTruthy();
    expect(screen.getByRole("link", { name: t.telegramGroup })).toBeTruthy();
  });

  it("на таджикском подписи устройств тоже переведены", () => {
    render(<DeviceLimitScreen t={dict("tg")} limit={limit()} onReplace={() => undefined} />);
    expect(screen.getByText("Компютер")).toBeTruthy();
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
