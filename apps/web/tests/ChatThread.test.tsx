import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatThread } from "../src/course/chat/ChatThread";
import { dict } from "../src/course/i18n";

const { loadChat, sendChat } = vi.hoisted(() => ({ loadChat: vi.fn(), sendChat: vi.fn() }));
vi.mock("../src/course/api", () => ({ loadChat, sendChat }));
beforeEach(() => {
  loadChat.mockReset();
  sendChat.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("student question state", () => {
  it.each(["ru", "tg"] as const)("shows only saved status in %s, without claiming delivery to a teacher", async (lang) => {
    loadChat.mockResolvedValue({ messages: [{ id: "q", fromStudent: true, text: "Question" }] });
    const t = dict(lang);
    render(<ChatThread t={t} lessonId={null} online={true} />);
    expect(await screen.findByText(t.questionSaved)).toBeTruthy();
  });
  it("removes waiting state when an answer is in the history", async () => {
    loadChat.mockResolvedValue({ messages: [{ id: "q", fromStudent: true, text: "Question" }, { id: "a", fromStudent: false, text: "Answer" }] });
    const t = dict("ru");
    render(<ChatThread t={t} lessonId={null} online={true} />);
    await screen.findByText("Answer");
    expect(screen.queryByText(t.questionSaved)).toBeNull();
  });
  it("does not present a failed history request as an empty conversation", async () => {
    loadChat.mockRejectedValue(new Error("network"));
    const t = dict("ru");
    render(<ChatThread t={t} lessonId={null} online={true} />);
    await screen.findByText(t.chatLoadFailed);
    expect(screen.queryByText(t.chatEmpty)).toBeNull();
    expect(screen.queryByText(t.questionSaved)).toBeNull();
  });
});


describe("visible online polling", () => {
  it("fetches new teacher answers, pauses hidden/offline, and stops after unmount", async () => {
    vi.useFakeTimers();
    loadChat.mockResolvedValueOnce({ messages: [{ id: "q", fromStudent: true, text: "Question" }] });
    const view = render(<ChatThread t={dict("ru")} lessonId={null} online={true} />);
    await act(async () => {});
    loadChat.mockResolvedValue({ messages: [{ id: "q", fromStudent: true, text: "Question" }, { id: "a", fromStudent: false, text: "Teacher answer" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByText("Teacher answer")).toBeTruthy();
    const count = loadChat.mock.calls.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(24000); });
    expect(loadChat).toHaveBeenCalledTimes(count);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(24000); });
    expect(loadChat).toHaveBeenCalledTimes(count);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await act(async () => { fireEvent(window, new Event("online")); });
    expect(loadChat).toHaveBeenCalledTimes(count + 1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(24000); });
    expect(loadChat).toHaveBeenCalledTimes(count + 1);
  });

  it("serializes slow polls and sends; a stale read cannot erase the newly submitted question", async () => {
    vi.useFakeTimers();
    let finishRead!: (result: { messages: unknown[] }) => void;
    loadChat.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    render(<ChatThread t={dict("ru")} lessonId={null} online={true} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(24000); });
    expect(loadChat).toHaveBeenCalledTimes(1);
    sendChat.mockResolvedValue({ messages: [{ id: "new", fromStudent: true, text: "New question" }] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New question" } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(sendChat).not.toHaveBeenCalled();
    await act(async () => { finishRead({ messages: [] }); });
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText("New question")).toBeTruthy();
    loadChat.mockRejectedValue(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByText("New question")).toBeTruthy();
  });
});
