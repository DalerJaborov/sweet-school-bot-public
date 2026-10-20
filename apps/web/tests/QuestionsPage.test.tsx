import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QuestionsPage } from "../src/pages/QuestionsPage";
import { ToastHost } from "../src/components/Toast";
import type { ChatRow } from "../src/api";

/**
 * «Черновик от ИИ» в inbox вопросов: текст ложится в поле (его можно
 * править), рядом — по чему собран; отправка по-прежнему через /reply.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rows: ChatRow[] = [
  { id: "q1", who: "@madina", lesson: "Наполеон", fromStudent: true, byBot: false, text: "Можно молоко 2,5%?", answered: false, createdAt: "2026-09-05T04:00:00Z" },
];

function mockApi(draft: { draft: string; source: string } | { draft: null; reason: string; note: string }) {
  const calls: { url: string; method: string; body?: { text: string } }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/admin/course-chat") return new Response(JSON.stringify({ unanswered: 1, rows }), { status: 200 });
      if (url === "/admin/course-chat/q1/draft") return new Response(JSON.stringify(draft), { status: 200 });
      if (url === "/admin/course-chat/q1/reply") return new Response(JSON.stringify({ ok: true, unanswered: 0 }), { status: 200 });
      return new Response("{}", { status: 404 });
    })
  );
  return calls;
}

describe("QuestionsPage — черновик от ИИ", () => {
  it("заполняет поле, показывает источник; отправка идёт через /reply с правленым текстом", async () => {
    const calls = mockApi({ draft: "Да, 2,5% подойдёт.", source: "по рецепту урока 7 «Наполеон»" });
    render(<QuestionsPage />);
    const area = (await screen.findByLabelText("Ответ для @madina")) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Черновик от ИИ" }));
    });
    expect(area.value).toBe("Да, 2,5% подойдёт.");
    expect(screen.getByText(/Черновик ИИ по рецепту урока 7/)).toBeTruthy();
    // Черновик ничего не отправил.
    expect(calls.some((c) => c.url.endsWith("/reply"))).toBe(false);

    fireEvent.change(area, { target: { value: "Да, 2,5% подойдёт. Удачи!" } });
    expect(screen.queryByText(/Черновик ИИ/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    });
    expect(calls.find((c) => c.url.endsWith("/reply"))?.body).toEqual({ text: "Да, 2,5% подойдёт. Удачи!" });
  });

  it("материала нет — поле пустое, причина в тосте", async () => {
    mockApi({ draft: null, reason: "no_material", note: "В рецептах ответа нет — лучше ответить самой" });
    render(
      <>
        <QuestionsPage />
        <ToastHost />
      </>
    );
    const area = (await screen.findByLabelText("Ответ для @madina")) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Черновик от ИИ" }));
    });
    expect(area.value).toBe("");
    expect(screen.getByText("В рецептах ответа нет — лучше ответить самой")).toBeTruthy();
  });
});
