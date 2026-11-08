import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { BehaviorSwitches } from "../src/components/BehaviorSwitches";
import { ToastHost } from "../src/components/Toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockApi(settings: Record<string, string>) {
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/admin/settings" && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify(settings), { status: 200 });
    if (url === "/admin/settings" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
  return puts;
}

describe("BehaviorSwitches — рубильники поведения помощника", () => {
  it("по умолчанию всё включено, выключенное из настроек видно выключенным", async () => {
    mockApi({ replyGateEnabled: "false" });
    render(<><BehaviorSwitches /><ToastHost /></>);
    await waitFor(() => expect(screen.getByTestId("switch-replyGateEnabled")).toBeTruthy());
    expect((screen.getByTestId("switch-replyGateEnabled") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("switch-reactionsEnabled") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("switch-readReceiptsEnabled") as HTMLInputElement).checked).toBe(true);
  });

  it("переключение отправляет настройку на сервер строкой false или true", async () => {
    const puts = mockApi({});
    render(<><BehaviorSwitches /><ToastHost /></>);
    await waitFor(() => expect(screen.getByTestId("switch-reactionsEnabled")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switch-reactionsEnabled"));
    await waitFor(() => expect(puts).toContainEqual({ reactionsEnabled: "false" }));
    fireEvent.click(screen.getByTestId("switch-reactionsEnabled"));
    await waitFor(() => expect(puts).toContainEqual({ reactionsEnabled: "true" }));
  });
});
