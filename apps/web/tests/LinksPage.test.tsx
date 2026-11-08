import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LinksPage } from "../src/pages/LinksPage";
import { ConfirmHost } from "../src/components/ConfirmDialog";
import { ManualEnrollment } from "../src/components/ManualEnrollment";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const options = {
  targets: [
    { key: "home", label: "Главная страница" },
    { key: "art", label: "Курс «Арт-десерты»" },
  ],
  sources: [
    { key: "instagram", label: "Instagram", needsLabel: false },
    { key: "blogger", label: "Блогер", needsLabel: true },
  ],
  groups: [
    { key: "COURSE50", label: "Курс «Арт-десерты»", ready: true },
    { key: "COURSE70", label: "Курс «21 рецепт»", ready: false },
  ],
  presets: [
    { key: "one", label: "1 человек · 30 дней" },
    { key: "five", label: "До 5 человек · 7 дней" },
  ],
  botReady: true,
};

const siteRow = {
  id: "l1",
  url: "https://shirinsweets.online/go/abc234",
  targetLabel: "Онлайн-курс",
  sourceLabel: "Блогер",
  label: "Мадина",
  lang: "tg",
  clicks: 12,
  leads: 3,
  buyers: 1,
  createdAt: "2026-11-08T10:00:00Z",
};
const inviteRow = {
  id: "i1",
  groupLabel: "Курс «Арт-десерты»",
  link: "https://t.me/+Abc",
  name: "Зарина",
  memberLimit: 1,
  joinedCount: 0,
  expiresAt: "2026-12-08T10:00:00Z",
  createdAt: "2026-11-08T10:00:00Z",
  status: "active",
};

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
function mockApi(overrides: Record<string, Handler> = {}, opts = options) {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const routes: Record<string, Handler> = {
    "GET /admin/v1/links/options": () => json(opts),
    "GET /admin/v1/links/site": () => json({ links: [siteRow] }),
    "GET /admin/v1/links/telegram": () => json({ invites: [inviteRow] }),
    "POST /admin/v1/links/site": () =>
      json({ link: { id: "l2", code: "new234", url: "https://shirinsweets.online/go/new234" } }, 201),
    "POST /admin/v1/links/telegram": () => json({ invite: { id: "i2", link: "https://t.me/+Fresh" } }, 201),
    "POST /admin/v1/links/telegram/i1/revoke": () => json({ ok: true }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodyOf = (fetchMock: ReturnType<typeof mockApi>, method: string, url: string) => {
  const call = fetchMock.mock.calls.find(([u, i]) => u === url && (i?.method ?? "GET") === method);
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
};

describe("LinksPage — ссылка на сайт", () => {
  it("два блока и списки с цифрами простыми словами", async () => {
    mockApi();
    render(<LinksPage />);
    expect(await screen.findByRole("heading", { name: "Ссылка на сайт" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ссылка в Telegram-группу" })).toBeTruthy();
    expect(
      await screen.findByText("12 переходов · 3 обратились через чат или форму на сайте · 1 купил через чат на сайте"),
    ).toBeTruthy();
    expect(screen.getByText(/Покупки через WhatsApp и Instagram сюда не попадают/)).toBeTruthy();
    expect(await screen.findByText(/Зарина · Курс «Арт-десерты»/)).toBeTruthy();
    // Ненастроенная группа не предлагается.
    expect(screen.queryByRole("option", { name: "Курс «21 рецепт»" })).toBeNull();
  });

  it("блогер без имени — подсказка, запрос не уходит; с именем — ссылка, копирование", async () => {
    const fetchMock = mockApi();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<LinksPage />);
    const site = (await screen.findByRole("heading", { name: "Ссылка на сайт" })).closest("section") as HTMLElement;
    fireEvent.change(within(site).getByLabelText("Куда ведёт"), { target: { value: "art" } });
    fireEvent.click(within(site).getByRole("button", { name: "Русский" }));
    fireEvent.click(within(site).getByLabelText("Блогер"));
    fireEvent.click(within(site).getByRole("button", { name: "Создать ссылку" }));
    expect(await within(site).findByRole("alert")).toBeTruthy();
    expect(bodyOf(fetchMock, "POST", "/admin/v1/links/site")).toBeUndefined();

    // Предупреждение: имя попадёт в адрес страницы.
    expect(within(site).getByLabelText("Имя блогера").getAttribute("aria-describedby")).toBeTruthy();
    expect(within(site).getByText(/видно в адресе страницы/)).toBeTruthy();
    fireEvent.change(within(site).getByLabelText("Имя блогера"), { target: { value: "Мадина" } });
    fireEvent.click(within(site).getByRole("button", { name: "Создать ссылку" }));
    const url = (await within(site).findByLabelText("Готовая ссылка")) as HTMLInputElement;
    expect(url.value).toBe("https://shirinsweets.online/go/new234");
    expect(bodyOf(fetchMock, "POST", "/admin/v1/links/site")).toEqual({
      target: "art",
      lang: "ru",
      source: "blogger",
      label: "Мадина",
    });
    fireEvent.click(within(site).getByRole("button", { name: "Скопировать" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://shirinsweets.online/go/new234"));
  });
});

describe("LinksPage — Telegram", () => {
  it("создаёт приглашение и показывает отказ Telegram понятными словами", async () => {
    const fetchMock = mockApi({
      "POST /admin/v1/links/telegram": () =>
        new Response(
          JSON.stringify({
            error:
              "У бота нет права приглашать людей в эту группу. Сделайте бота администратором группы с правом «Приглашать участников».",
            reason: "no_rights",
          }),
          { status: 409 },
        ),
    });
    render(<LinksPage />);
    const tg = (await screen.findByRole("heading", { name: "Ссылка в Telegram-группу" })).closest(
      "section",
    ) as HTMLElement;
    fireEvent.change(within(tg).getByLabelText("Для кого (необязательно)"), { target: { value: "Зарина" } });
    fireEvent.change(within(tg).getByLabelText("Сколько входов"), { target: { value: "five" } });
    fireEvent.click(within(tg).getByRole("button", { name: "Создать ссылку" }));
    expect((await within(tg).findByRole("alert")).textContent).toContain("Приглашать участников");
    expect(bodyOf(fetchMock, "POST", "/admin/v1/links/telegram")).toEqual({
      group: "COURSE50",
      preset: "five",
      name: "Зарина",
    });
  });

  it("без бота — понятное предупреждение и кнопка выключена", async () => {
    mockApi({}, { ...options, botReady: false });
    render(<LinksPage />);
    const tg = (await screen.findByRole("heading", { name: "Ссылка в Telegram-группу" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(tg).getByText(/Бот Telegram не подключён/)).toBeTruthy();
    expect((within(tg).getByRole("button", { name: "Создать ссылку" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("отзыв — только после подтверждения", async () => {
    const fetchMock = mockApi();
    render(
      <>
        <LinksPage />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Отозвать ссылку для: Зарина" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/revoke"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Отозвать" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => u === "/admin/v1/links/telegram/i1/revoke")).toBe(true),
    );
  });

  it("входы набраны, но ссылка не погашена — «Отозвать» на экране; вошедшего можно удалить", async () => {
    const fetchMock = mockApi({
      "GET /admin/v1/links/telegram": () =>
        new Response(
          JSON.stringify({
            invites: [
              {
                ...inviteRow,
                id: "i5",
                name: "Группа ноябрь",
                memberLimit: 5,
                joinedCount: 5,
                joins: [
                  { id: "j1", name: "Нигора @nigora", joinedAt: "2026-11-08T10:00:00Z", removed: false },
                  { id: "j2", name: "Telegram 777", joinedAt: "2026-11-08T11:00:00Z", removed: true },
                ],
              },
            ],
          }),
        ),
      "POST /admin/v1/links/telegram/i5/joins/j1/remove": () => new Response(JSON.stringify({ ok: true })),
    });
    render(
      <>
        <LinksPage />
        <ConfirmHost />
      </>,
    );
    expect(await screen.findByRole("button", { name: "Отозвать ссылку для: Группа ноябрь" })).toBeTruthy();
    expect(screen.getByText("удалили из группы")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить из группы: Нигора @nigora" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => u === "/admin/v1/links/telegram/i5/joins/j1/remove")).toBe(true),
    );
  });
});

describe("ManualEnrollment — ссылка в группу рядом с доступом", () => {
  it("выпускает приглашение на один вход для этой ученицы", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/catalog"))
          return new Response(
            JSON.stringify({ courses: [{ code: "COURSE50", title: "Арт-десерты", price: 85 }], bundlePrice: 150 }),
          );
        if (url === "/admin/v1/links/telegram")
          return new Response(JSON.stringify({ invite: { link: "https://t.me/+One" } }), { status: 201 });
        return new Response(
          JSON.stringify({
            contactId: "manual-1",
            url: "https://school.tj/l/Abc",
            createdCourses: ["COURSE50"],
            alreadyEnrolled: false,
          }),
        );
      }),
    );
    render(<ManualEnrollment onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оплатившую ученицу" }));
    await screen.findByRole("option", { name: "Арт-десерты — 85 сомони" });
    fireEvent.change(screen.getByLabelText("Имя ученицы"), { target: { value: "Мадина" } });
    fireEvent.change(screen.getByLabelText("Телефон WhatsApp"), { target: { value: "+992905355355" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Записать оплату и получить ссылку" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ссылка в группу «Арт-десерты»" }));
    expect(((await screen.findByLabelText("Ссылка в группу Арт-десерты")) as HTMLInputElement).value).toBe(
      "https://t.me/+One",
    );
    const invite = calls.find(([u]) => u === "/admin/v1/links/telegram");
    expect(JSON.parse(String(invite?.[1]?.body))).toEqual({
      group: "COURSE50",
      preset: "one",
      name: "Мадина",
      contactId: "manual-1",
    });
  });
});
