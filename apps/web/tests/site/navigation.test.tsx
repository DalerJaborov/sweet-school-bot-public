import { afterEach, expect, it, vi } from "vitest";
const renderRoot = vi.hoisted(() => vi.fn());
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: renderRoot }) }));
vi.mock("../../src/site/lang", () => ({ syncLangOnEntry: () => false, pageLang: () => "ru", bindLangSwitch: () => {} }));
vi.mock("../../src/site/chat/ChatLauncher", () => ({ ChatLauncher: () => null }));
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });
it("Escape returns focus to the menu and a paused chat preserves the contact fallback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({enabled:false}))));
  document.body.innerHTML = '<button data-menu-toggle aria-expanded="false">Menu</button><nav id="mobile-nav" data-open="false"><a href="/faq">FAQ</a></nav><a data-chat="Order" href="https://api.whatsapp.com/send?phone=992905355355">Buy</a>';
  await import("../../src/site/main");
  const button=document.querySelector<HTMLButtonElement>("button")!;
  button.click(); expect(button.getAttribute("aria-expanded")).toBe("true");
  document.querySelector<HTMLElement>("nav a")!.focus();
  document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  expect(button.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(button);
  const link=document.querySelector<HTMLElement>("[data-chat]")!;
  const event=new MouseEvent("click",{bubbles:true,cancelable:true});
  // Prevent jsdom navigation after measuring the handler, without changing its default result.
  let prevented=false;document.addEventListener("click",e=>{prevented=e.defaultPrevented;e.preventDefault();},{once:true});
  link.dispatchEvent(event); expect(prevented).toBe(false);
});
it("the buy action queues its exact course draft while the lazy launcher mounts", async () => {
  const { openChat, onChatOpen } = await import("../../src/site/chat/bus");
  openChat("Арт-десерты · 85 сомони"); const opened=vi.fn(); const stop=onChatOpen(opened);
  expect(opened).toHaveBeenCalledWith({prefill:"Арт-десерты · 85 сомони"});stop();
});
