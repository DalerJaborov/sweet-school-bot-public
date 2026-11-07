import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRoot, render } = vi.hoisted(() => ({ createRoot: vi.fn(), render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("../../src/site/lang", () => ({
  syncLangOnEntry: () => false,
  pageLang: () => "ru",
  bindLangSwitch: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  createRoot.mockReturnValue({ render });
  document.body.innerHTML = "";
});

describe("catalogue delivered in HTML", () => {
  it("retains the server price and working order link when JavaScript starts", async () => {
    document.body.innerHTML = '<div id="courses-island"><div data-server-catalog="ready"><a href="https://wa.me/992905355355">75 сомони</a></div></div>';
    await import("../../src/site/main");
    expect(createRoot).not.toHaveBeenCalled();
    expect(document.querySelector("#courses-island a")?.textContent).toBe("75 сомони");
    expect(document.querySelector("#courses-island a")?.getAttribute("href")).toBe("https://wa.me/992905355355");
  });

  it("starts the client retry path when the server catalogue was unavailable", async () => {
    document.body.innerHTML = '<div id="courses-island"><div data-server-catalog="unavailable">Contact us</div></div>';
    await import("../../src/site/main");
    expect(createRoot).toHaveBeenCalledWith(document.getElementById("courses-island"));
    expect(render).toHaveBeenCalledTimes(1);
  });
});
