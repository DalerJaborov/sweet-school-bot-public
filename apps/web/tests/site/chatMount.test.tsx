import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const mounted = vi.hoisted(() => vi.fn());
const renderRoot = vi.hoisted(() => vi.fn());
vi.mock("react-dom/client", () => ({ createRoot: mounted }));
vi.mock("../../src/site/lang", () => ({ syncLangOnEntry: () => false, pageLang: () => "ru", bindLangSwitch: () => undefined }));
vi.mock("../../src/site/chat/ChatLauncher", () => ({ ChatLauncher: () => null }));
vi.mock("../../src/site/CoursesIsland", () => ({ CoursesIsland: () => null }));
vi.mock("../../src/site/OfflineForm", () => ({ OfflineForm: () => null }));

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  mounted.mockReset().mockReturnValue({ render: renderRoot });
  renderRoot.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("public site shared-assistant mount", () => {
  it("mounts the existing chat only when the server enables it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await import("../../src/site/main");
    await waitFor(() => expect(renderRoot).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/site/chat-status", { cache: "no-store" });
    expect(mounted).toHaveBeenCalledOnce();
  });
  it("keeps the chat unmounted when the server pauses it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 })));
    await import("../../src/site/main");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mounted).not.toHaveBeenCalled();
  });
  it("keeps the chat unmounted when the status request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await import("../../src/site/main");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mounted).not.toHaveBeenCalled();
  });
});
