import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { AttentionPage } from "../src/pages/AttentionPage";
import { ToastHost } from "../src/components/Toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const chats = [
  { contactId: "c1", name: "Мадина", lastText: "Сколько стоит курс?", kind: "text", reason: "Помощник не смог придумать ответ", count: 1, at: "2026-11-08T10:00:00Z" },
  { contactId: "c2", name: "+992900000000", lastText: "", kind: "voice", reason: "Клиент прислал вложение, которое помощник не умеет читать", count: 3, at: "2026-11-08T09:00:00Z" },
];

function mockApi(list = chats, postStatus = 200) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/admin/v1/conversations/attention") return new Response(JSON.stringify({ chats: list }), { status: 200 });
    if (method === "POST") return new Response(JSON.stringify(postStatus === 200 ? { ok: true } : { error: "Нет связи с WhatsApp, попробуйте через минуту" }), { status: postStatus });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

describe("AttentionPage — «Нужен ваш ответ»", () => {
  it("shows the reason in plain words and the client's last message", async () => {
    mockApi();
    render(<AttentionPage />);
    expect(await screen.findByText("Мадина")).toBeTruthy();
    expect(screen.getByText(/Сколько стоит курс\?/)).toBeTruthy();
    expect(screen.getByText(/Почему: Помощник не смог придумать ответ/)).toBeTruthy();
    expect(screen.getByText(/Клиент прислал голосовое/)).toBeTruthy();
    expect(screen.getByText(/Сообщений без ответа: 3/)).toBeTruthy();
  });

  it("«Ответила сама» calls the API and removes the chat", async () => {
    const calls = mockApi();
    const onChange = vi.fn();
    render(<><AttentionPage onChange={onChange} /><ToastHost /></>);
    await screen.findByText("Мадина");
    fireEvent.click(screen.getAllByText("Ответила сама")[0]);
    await waitFor(() => expect(screen.queryByText("Мадина")).toBeNull());
    expect(calls).toContainEqual({ url: "/admin/v1/conversations/c1/answered", method: "POST" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText("+992900000000")).toBeTruthy();
  });

  it("«Вернуть боту» calls its own route", async () => {
    const calls = mockApi();
    render(<AttentionPage />);
    await screen.findByText("Мадина");
    fireEvent.click(screen.getAllByText("Вернуть боту")[1]);
    await waitFor(() => expect(calls).toContainEqual({ url: "/admin/v1/conversations/c2/return-to-bot", method: "POST" }));
  });

  it("keeps the chat visible when the server refuses", async () => {
    mockApi(chats, 503);
    render(<><AttentionPage /><ToastHost /></>);
    await screen.findByText("Мадина");
    fireEvent.click(screen.getAllByText("Вернуть боту")[0]);
    expect(await screen.findByText(/Нет связи с WhatsApp/)).toBeTruthy();
    expect(screen.getByText("Мадина")).toBeTruthy();
  });

  it("says everything is answered when the list is empty", async () => {
    mockApi([]);
    render(<AttentionPage />);
    expect(await screen.findByText("Все клиенты получили ответ")).toBeTruthy();
  });
});
