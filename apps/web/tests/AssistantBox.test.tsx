import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { AssistantBox } from "../src/components/AssistantBox";
import { ToastHost } from "../src/components/Toast";
import type { AssistantAnswer } from "../src/api";

/**
 * «Спросить помощницу»: чип заполняет поле и отправляет; под ответом —
 * «Откуда цифры» с таблицей по каждому инструменту; черновик — карточкой
 * со «Скопировать» и «Открыть вопросы», без кнопки отправки.
 */
const reply: AssistantAnswer = {
  answer: "За неделю продали на 240 с. — 4 оплаты.",
  sources: [
    {
      tool: "money",
      args: { days: 7 },
      summary: "за 7 дн.: 240 с., 4 оплат",
      data: { days: 7, total: 240, count: 4, byCourse: [{ key: "COURSE_70", title: "21 рецепт", sum: 140, count: 2 }] },
    },
  ],
  draft: { text: "Сливки берите 33% — как в рецепте урока 7.", forContactId: "c1" },
};

const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify(reply), { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssistantBox", () => {
  it("чип заполняет поле и отправляет вопрос с пустой историей", async () => {
    render(<AssistantBox onOpenQuestions={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "сколько продали на этой неделе?" }));
    await screen.findByRole("region", { name: "Ответ помощницы" });
    expect(calls).toEqual([{ url: "/admin/assistant/ask", body: { question: "сколько продали на этой неделе?", history: [] } }]);
    expect(screen.getByText("За неделю продали на 240 с. — 4 оплаты.")).toBeTruthy();
    // Следующий вопрос уносит историю из двух реплик.
    const input = screen.getByRole("textbox", { name: "Вопрос помощнице" });
    fireEvent.change(input, { target: { value: "а за месяц?" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("region", { name: "Ответ помощницы" });
    expect(calls[1].body).toEqual({
      question: "а за месяц?",
      history: [
        { role: "user", text: "сколько продали на этой неделе?" },
        { role: "model", text: "За неделю продали на 240 с. — 4 оплаты." },
      ],
    });
  });

  it("«Откуда цифры» раскрывается в список источников, источник — в таблицу", async () => {
    render(<AssistantBox onOpenQuestions={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "кто не открыл урок?" }));
    const region = await screen.findByRole("region", { name: "Ответ помощницы" });
    expect(within(region).getByText("Откуда цифры · 1")).toBeTruthy();
    expect(within(region).getByText("Выручка")).toBeTruthy();
    expect(within(region).getByText("days: 7")).toBeTruthy();
    const tables = within(region).getAllByRole("table");
    // Скаляры — пары ключ/значение; byCourse — своей таблицей.
    expect(within(tables[0]).getByText("total").nextElementSibling?.textContent).toBe("240");
    expect(within(tables[1]).getByText("21 рецепт")).toBeTruthy();
    expect(within(region).getByText("byCourse")).toBeTruthy();
  });

  it("черновик: «Скопировать» кладёт текст в буфер, «Открыть вопросы» зовёт onOpenQuestions, кнопки «Отправить» нет", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onOpenQuestions = vi.fn();
    render(
      <>
        <ToastHost />
        <AssistantBox onOpenQuestions={onOpenQuestions} />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "напиши Мадине ответ про сливки" }));
    const draft = await screen.findByTestId("assistant-draft");
    expect(within(draft).getByText("Сливки берите 33% — как в рецепте урока 7.")).toBeTruthy();
    fireEvent.click(within(draft).getByRole("button", { name: "Скопировать" }));
    expect(writeText).toHaveBeenCalledWith("Сливки берите 33% — как в рецепте урока 7.");
    await screen.findByText(/скопирован/);
    fireEvent.click(within(draft).getByRole("button", { name: "Открыть вопросы" }));
    expect(onOpenQuestions).toHaveBeenCalled();
    expect(within(draft).queryByRole("button", { name: /Отправить/ })).toBeNull();
  });

  it("ошибка сервера — тост, поле остаётся с вопросом", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Помощница сейчас не отвечает" }), { status: 503 }))
    );
    render(
      <>
        <ToastHost />
        <AssistantBox onOpenQuestions={vi.fn()} />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "кто не открыл урок?" }));
    await screen.findByText("Помощница сейчас не отвечает");
    expect((screen.getByRole("textbox", { name: "Вопрос помощнице" }) as HTMLInputElement).value).toBe("кто не открыл урок?");
  });
});
