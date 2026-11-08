import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
  const noop = { onRequest: async () => "sent" as const, onConfirm: async () => true };

  it("перечисляет устройства: подпись, город, «вчера», значок блокировки", () => {
    render(<DeviceLimitScreen t={t} limit={limit()} {...noop} />);
    expect(screen.getByText("iPhone · Душанбе")).toBeTruthy();
    expect(screen.getByText("Компьютер")).toBeTruthy();
    expect(screen.getByText("в сети вчера")).toBeTruthy();
    expect(screen.getByText("заблокировано")).toBeTruthy();
  });

  it("ГЛАВНОЕ: сообщение про другой телефон, «Перенести» просит код, потом ввод кода", async () => {
    const onRequest = vi.fn(async () => "sent" as const);
    const onConfirm = vi.fn(async () => true);
    render(<DeviceLimitScreen t={t} limit={limit()} onRequest={onRequest} onConfirm={onConfirm} />);
    expect(screen.getByText(t.deviceLimitTitle)).toBeTruthy();
    expect(screen.getByText(/нажмите «Перенести», вам придёт код в WhatsApp/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t.transferButton }));
    await screen.findByText(t.transferSent);
    expect(onRequest).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText(t.transferCodeLabel) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12ab34" } }); // буквы отбрасываются
    expect(input.value).toBe("1234");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: t.transferConfirm }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("123456"));
  });

  it("неверный код — подсказка, форма остаётся", async () => {
    render(<DeviceLimitScreen t={t} limit={limit()} onRequest={async () => "sent"} onConfirm={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: t.transferButton }));
    const input = await screen.findByLabelText(t.transferCodeLabel);
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: t.transferConfirm }));
    await screen.findByText(t.transferBadCode);
  });

  it("перенос в этом месяце уже был — «спросили Ширин», без поля кода", async () => {
    render(<DeviceLimitScreen t={t} limit={limit()} onRequest={async () => "owner_asked"} onConfirm={async () => true} />);
    fireEvent.click(screen.getByRole("button", { name: t.transferButton }));
    await screen.findByText(t.transferOwnerAsked);
    expect(screen.queryByLabelText(t.transferCodeLabel)).toBeNull();
  });

  it("не удалось отправить код — «напишите нам» и контакты школы", async () => {
    render(
      <DeviceLimitScreen
        t={t}
        limit={limit({ school: { telegram: "https://t.me/x", instagram: null, whatsapp: null } })}
        onRequest={async () => "send_failed"}
        onConfirm={async () => true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.transferButton }));
    await screen.findByText(t.transferSendFailed);
    expect(screen.getByRole("link", { name: t.telegramGroup })).toBeTruthy();
  });

  it("на таджикском сообщение и подписи устройств тоже переведены", () => {
    render(<DeviceLimitScreen t={dict("tg")} limit={limit()} {...noop} />);
    expect(screen.getByText("Компютер")).toBeTruthy();
    expect(screen.getByText(dict("tg").transferButton)).toBeTruthy();
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
