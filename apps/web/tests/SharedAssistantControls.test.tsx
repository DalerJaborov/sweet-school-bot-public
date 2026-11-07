import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const callApi = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: callApi }));
import { WhatsAppSettings } from "../src/components/WhatsAppSettings";
import { KnowledgeReview } from "../src/components/KnowledgeReview";

const reviewedRow = { id: "q1", studentText: "Как приготовить крем?", ownerText: "Сливки взбейте согласно рецепту курса.", courseId: null, approvedForAnswer: false, eligible: true, reviewHash: "a".repeat(64) };
const page = { examples: [reviewedRow], courses: [{ id: "course-1", title: "Арт-десерты" }], nextCursor: "q20" };
let waStatus: Record<string, unknown>;
beforeEach(() => {
  waStatus = { state: "ready", contactsReady: true, blockedCount: 12 };
  callApi.mockReset().mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === "POST") return { ok: true };
    if (path === "/admin/v1/whatsapp/status") return waStatus;
    if (path === "/admin/v1/conversations/paused") return [];
    return page;
  });
});
afterEach(cleanup);

describe("WhatsApp owner controls", () => {
  it("does not invent a QR when the server has not returned one", async () => {
    render(<WhatsAppSettings />);
    await screen.findByText("Подключён");
    expect(screen.queryByRole("img", { name: /QR-код/ })).toBeNull();
  });
  it("renders only an actual inline QR returned by the server", async () => {
    waStatus = { state: "qr", contactsReady: false, qrDataUrl: "data:image/png;base64,dGVzdA==" };
    render(<WhatsAppSettings />);
    const qr = await screen.findByRole("img", { name: "QR-код подключения WhatsApp" });
    expect(qr.getAttribute("src")).toBe(waStatus.qrDataUrl);
    expect((screen.getByRole("button", { name: "Включить ответы" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("rejects a remote URL as a QR image", async () => {
    waStatus = { state: "qr", contactsReady: false, qrDataUrl: "https://untrusted.example/qr.png" };
    render(<WhatsAppSettings />);
    await screen.findByText("Отсканируйте QR-код");
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("cannot resume before saved contacts have been checked", async () => {
    waStatus = { state: "synchronizing", contactsReady: false };
    render(<WhatsAppSettings />);
    await screen.findByText("Проверяем контакты");
    const button = screen.getByRole("button", { name: "Включить ответы" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(callApi.mock.calls.some(([path]) => path.endsWith("/resume"))).toBe(false);
  });
  it("pause uses the authenticated action endpoint and a JSON object", async () => {
    render(<WhatsAppSettings />);
    await screen.findByText("Подключён");
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    await waitFor(() => expect(callApi).toHaveBeenCalledWith("/admin/v1/whatsapp/pause", { method: "POST", body: {} }));
  });
  it("shows a connection failure without claiming connection succeeded", async () => {
    callApi.mockRejectedValue(new Error("Нет связи с подключением"));
    render(<WhatsAppSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("Нет связи с подключением");
    expect(screen.queryByText("Подключён")).toBeNull();
  });
});

function openKnowledge() {
  const view = render(<KnowledgeReview />);
  const details = view.container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("reviewed teaching answers", () => {
  it("does not fetch the private archive until opened", () => {
    render(<KnowledgeReview />);
    expect(callApi).not.toHaveBeenCalled();
  });
  it("requires a course and submits the hash of the text the owner reviewed", async () => {
    openKnowledge();
    await screen.findByText(reviewedRow.studentText, { exact: false });
    const approval = screen.getByRole("checkbox", { name: /Ответ проверен/ }) as HTMLInputElement;
    expect(approval.disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "course-1" } });
    expect(approval.disabled).toBe(false);
    fireEvent.click(approval);
    await waitFor(() => expect(callApi).toHaveBeenCalledWith("/admin/v1/knowledge/examples/q1", { method: "POST", body: { approved: true, courseId: "course-1", reviewHash: reviewedRow.reviewHash } }));
    await waitFor(() => expect(approval.checked).toBe(true));
  });
  it("uses the next cursor rather than repeatedly showing the first twenty", async () => {
    openKnowledge();
    fireEvent.click(await screen.findByRole("button", { name: "Следующие ответы" }));
    await waitFor(() => expect(callApi).toHaveBeenCalledWith("/admin/v1/knowledge/examples?approved=false&after=q20"));
  });
  it("keeps approval off and displays a stale-content rejection", async () => {
    const normal = callApi.getMockImplementation()!;
    callApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "POST") throw new Error("Ответ изменился. Обновите список");
      return normal(path, options);
    });
    openKnowledge();
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "course-1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Ответ проверен/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Ответ изменился");
    expect((screen.getByRole("checkbox", { name: /Ответ проверен/ }) as HTMLInputElement).checked).toBe(false);
  });
});
