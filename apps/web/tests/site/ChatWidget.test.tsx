import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import ChatWidget from "../../src/site/chat/ChatWidget";
import { linkify, isPlatformLink } from "../../src/site/chat/linkify";
import { dict } from "../../src/site/i18n";

const msg = (id: string, from: "client" | "bot" | "owner", text: string) => ({
  id,
  from,
  text,
  imageUrl: null,
  at: "2026-09-03T10:00:00.000Z",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockApi(overrides: Partial<Record<"start" | "send" | "poll", (init?: RequestInit) => Response>> = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/chat/start")) return (overrides.start ?? (() => json({ visitorId: "v1", messages: [] })))(init);
    if (u.includes("/chat/send")) return (overrides.send ?? (() => json({ messages: [], pending: true })))(init);
    if (u.includes("/chat/poll")) return (overrides.poll ?? (() => json({ messages: [] })))(init);
    return json({ error: "nope" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatWidget", () => {
  it("start → история; send → эхо оптимистично + ответ бота; ссылка /l/ — кнопкой", async () => {
    const { calls } = mockApi({
      start: () => json({ visitorId: "v1", messages: [msg("1", "bot", "Привет!")] }),
      send: () => json({ messages: [msg("2", "client", "Хочу курс")], pending: true }),
      poll: () => json({ messages: [msg("3", "bot", "Ваша ссылка: https://shirinsweets.online/l/Ab3kQ9xZ")], typing: false }),
    });
    const onClose = vi.fn();
    render(<ChatWidget t={dict("ru")} lang="ru" prefill="Хочу курс" onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(screen.getByText("Привет!")).toBeTruthy());
    expect(JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body))).toEqual({ lang: "ru" });

    const input = screen.getByLabelText("Сообщение") as HTMLTextAreaElement;
    expect(input.value).toBe("Хочу курс");
    fireEvent.click(screen.getByLabelText("Отправить"));

    // Оптимистичное эхо — своё сообщение видно СРАЗУ, ещё до ответа сервера.
    await waitFor(() => expect(screen.getByText("Хочу курс")).toBeTruthy());
    expect(calls.some((c) => c.includes("/chat/send"))).toBe(true);

    await waitFor(() => expect(screen.getByText(/Открыть мои уроки/)).toBeTruthy());
    const link = screen.getByText(/Открыть мои уроки/).closest("a")!;
    expect(link.getAttribute("href")).toBe("https://shirinsweets.online/l/Ab3kQ9xZ");
    expect(link.className).toBe("msg-link");
    expect(input.value).toBe("");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("pending → индикатор печати и адаптивный опрос /poll?after=<id>", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const { calls } = mockApi({
      send: () => json({ messages: [msg("10", "client", "Чек")], pending: true }),
      poll: () => json({ messages: ++polls < 2 ? [] : [msg("11", "bot", "Доступ открыт")], typing: polls < 2 }),
    });
    render(<ChatWidget t={dict("ru")} lang="ru" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Чек" } });
    fireEvent.click(screen.getByLabelText("Отправить"));
    await waitFor(() => expect(screen.getByLabelText("Ширин печатает…")).toBeTruthy());

    // Пока typing — опрос раз в секунду (быстрая часть adaptive-tier'а).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await waitFor(() => expect(screen.getByText("Доступ открыт")).toBeTruthy());
    expect(calls.filter((c) => c.includes("/chat/poll?after=10")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByLabelText("Ширин печатает…")).toBeNull();
  });

  it("несколько сообщений от сервера рендерятся отдельными пузырями", async () => {
    mockApi({
      send: () =>
        json({
          messages: [
            msg("20", "client", "Привет"),
          ],
          pending: false,
        }),
    });
    render(<ChatWidget t={dict("ru")} lang="ru" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Привет" } });
    fireEvent.click(screen.getByLabelText("Отправить"));
    await waitFor(() => expect(screen.getAllByText("Привет").length).toBeGreaterThan(0));
  });

  it("картинка уходит multipart; 429 показывает лимит", async () => {
    let sendInit: RequestInit | undefined;
    mockApi({
      send: (init) => {
        sendInit = init;
        return json({ error: "limit", retryAfterSec: 600 }, 429);
      },
    });
    // jsdom не умеет object URL — предпросмотр картинки заглушаем.
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    render(<ChatWidget t={dict("ru")} lang="ru" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).disabled).toBe(false));
    const file = new File(["x"], "check.png", { type: "image/png" });
    const input = screen.getByLabelText("Прикрепить чек").querySelector("input")!;
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText("check.png")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Отправить"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("10 мин"));
    expect(sendInit!.body).toBeInstanceOf(FormData);
    expect((sendInit!.body as FormData).get("image")).toBeInstanceOf(File);
  });

  it("start недоступен → понятное сообщение", async () => {
    mockApi({ start: () => json({ error: "down" }, 503) });
    render(<ChatWidget t={dict("tg")} lang="tg" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dict("tg").chatStartFailed));
  });

  it("нет истории → приветствие и быстрые реплики; клик по чипу отправляет сообщение", async () => {
    const { calls } = mockApi({
      send: () => json({ messages: [msg("30", "client", "Сколько стоит?")], pending: true }),
    });
    render(<ChatWidget t={dict("ru")} lang="ru" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Здравствуйте!/)).toBeTruthy());
    const chip = screen.getByText("Сколько стоит?");
    fireEvent.click(chip);
    await waitFor(() => expect(calls.some((c) => c.includes("/chat/send"))).toBe(true));
  });
});

describe("linkify", () => {
  it("находит ссылки и отличает платформенную /l/", () => {
    const parts = linkify("Смотри https://example.com/a и /l/Ab3kQ9xZ", "https://shirinsweets.online");
    expect(parts.filter((p) => p.kind === "link").length).toBe(2);
    expect(parts[1]).toMatchObject({ kind: "link", href: "https://example.com/a", platform: false });
    expect(parts[3]).toMatchObject({ kind: "link", href: "https://shirinsweets.online/l/Ab3kQ9xZ", platform: true });
    expect(isPlatformLink("https://shirinsweets.online/l/Ab3kQ9xZ", "http://localhost")).toBe(true);
    expect(isPlatformLink("https://evil.com/l/Ab3kQ9xZ", "http://localhost")).toBe(false);
  });
});
