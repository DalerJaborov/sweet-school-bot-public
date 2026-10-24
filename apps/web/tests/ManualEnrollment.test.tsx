import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManualEnrollment } from "../src/components/ManualEnrollment";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const catalog = {
  courses: [
    { code: "COURSE50", title: "Арт-десерты", price: 85 },
    { code: "COURSE70", title: "21 рецепт", price: 95 },
  ],
  bundlePrice: 150,
};
function mockApi(submit?: () => Promise<Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/catalog")) return new Response(JSON.stringify(catalog));
    return submit
      ? submit()
      : new Response(
          JSON.stringify({
            contactId: "manual-1",
            url: "https://school.tj/l/Abcdefgh23",
            createdCourses: ["COURSE50"],
            alreadyEnrolled: false,
          }),
        );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
async function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Добавить оплатившую ученицу" }));
  await screen.findByRole("option", { name: "Арт-десерты — 85 сомони" });
  fireEvent.change(screen.getByLabelText("Имя ученицы"), { target: { value: "Мадина" } });
  fireEvent.change(screen.getByLabelText("Телефон WhatsApp"), { target: { value: "+992905355355" } });
}

describe("ManualEnrollment", () => {
  it("uses live catalogue prices and requires explicit payment confirmation before saving", async () => {
    const fetchMock = mockApi();
    const onSaved = vi.fn();
    render(<ManualEnrollment onSaved={onSaved} />);
    await openForm();
    const save = screen.getByRole("button", { name: "Записать оплату и получить ссылку" }) as HTMLButtonElement;
    expect((screen.getByLabelText("Фактически получено, сомони") as HTMLInputElement).value).toBe("85");
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Курс"), { target: { value: "BOTH" } });
    expect((screen.getByLabelText("Фактически получено, сомони") as HTMLInputElement).value).toBe("150");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Фактически получено, сомони"), { target: { value: "140" } });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await screen.findByText("Доступ открыт");
    const mutation = fetchMock.mock.calls.find(([url]) => url === "/admin/manual-enrollments");
    const init = (mutation as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "Мадина",
      phone: "+992905355355",
      lang: "tg",
      course: "BOTH",
      amount: 140,
      paymentConfirmed: true,
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Ссылка никому автоматически не отправлялась/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/admin/"))).toBe(true);
  });

  it("prevents double submission, preserves the returned link and copies only after owner action", async () => {
    let finish: ((value: Response) => void) | undefined;
    const fetchMock = mockApi(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ManualEnrollment onSaved={vi.fn()} />);
    await openForm();
    fireEvent.click(screen.getByRole("checkbox"));
    const form = screen.getByRole("form", { name: "Ручная продажа курса" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === "/admin/manual-enrollments")).toHaveLength(1),
    );
    finish!(
      new Response(
        JSON.stringify({
          contactId: "manual-1",
          url: "https://school.tj/l/Abcdefgh23",
          createdCourses: [],
          alreadyEnrolled: true,
        }),
      ),
    );
    await screen.findByText("Эти курсы уже открыты");
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await screen.findByText("Скопировано");
    expect(writeText).toHaveBeenCalledWith("https://school.tj/l/Abcdefgh23");
  });

  it("shows an explicit revoked-access conflict and keeps the form for owner review", async () => {
    mockApi(
      async () =>
        new Response(JSON.stringify({ error: "Покупка была отозвана. Восстановите её отдельно." }), { status: 409 }),
    );
    render(<ManualEnrollment onSaved={vi.fn()} />);
    await openForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Записать оплату и получить ссылку" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Покупка была отозвана");
    expect(screen.getByRole("form", { name: "Ручная продажа курса" })).toBeTruthy();
    expect(screen.queryByText("Доступ открыт")).toBeNull();
  });
});
