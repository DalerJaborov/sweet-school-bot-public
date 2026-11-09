import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccessLinkSheet } from "../src/components/AccessLinkSheet";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ANNA = { id: "c1", handle: "@anna", name: "Анна", courses: ["COURSE50"] };

function mockApi(issue: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/admin/access-link/search")) return new Response(JSON.stringify({ people: [ANNA] }));
    if (url.includes("/admin/access-link/issue")) return issue();
    throw new Error(`неожиданный запрос ${url} ${init?.method ?? ""}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function pickAnna() {
  fireEvent.change(screen.getByLabelText("Ник или имя ученицы"), { target: { value: "anna" } });
  fireEvent.click(screen.getByRole("button", { name: "Найти" }));
  fireEvent.click(await screen.findByRole("button", { name: /@anna/ }));
}

describe("AccessLinkSheet: выдать ссылку на уроки", () => {
  it("нашли → выбрали «На сайт» → получили ссылку", async () => {
    const fetchMock = mockApi(
      () => new Response(JSON.stringify({ ok: true, kind: "web", url: "https://school.test/l/AAA", courses: [] })),
    );
    render(<AccessLinkSheet open onClose={() => {}} />);
    await pickAnna();
    fireEvent.click(screen.getByRole("button", { name: "На сайт" }));
    const input = (await screen.findByLabelText("Ссылка на сайт")) as HTMLInputElement;
    expect(input.value).toBe("https://school.test/l/AAA");
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/issue"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ contactId: "c1", kind: "web" });
  });

  it("выбрали «В Telegram» — приглашение показано по курсу", async () => {
    mockApi(
      () =>
        new Response(
          JSON.stringify({ ok: true, kind: "telegram", links: [{ course: "COURSE50", url: "https://t.me/+AAA" }] }),
        ),
    );
    render(<AccessLinkSheet open onClose={() => {}} />);
    await pickAnna();
    fireEvent.click(screen.getByRole("button", { name: "В Telegram" }));
    const input = (await screen.findByLabelText(/Приглашение в группу «Арт-десерты»/)) as HTMLInputElement;
    expect(input.value).toBe("https://t.me/+AAA");
  });

  it("отказ сервера (уже в группе) показан словами, ссылки нет", async () => {
    mockApi(
      () =>
        new Response(JSON.stringify({ error: "Этот человек уже в группе — новое приглашение не выдаю." }), {
          status: 409,
        }),
    );
    render(<AccessLinkSheet open onClose={() => {}} />);
    await pickAnna();
    fireEvent.click(screen.getByRole("button", { name: "В Telegram" }));
    expect((await screen.findByRole("alert")).textContent).toContain("уже в группе");
    expect(screen.queryByLabelText(/Приглашение в группу/)).toBeNull();
  });

  it("короткий запрос не отправляется", () => {
    const fetchMock = mockApi(() => new Response("{}"));
    render(<AccessLinkSheet open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Ник или имя ученицы"), { target: { value: "a" } });
    expect((screen.getByRole("button", { name: "Найти" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
