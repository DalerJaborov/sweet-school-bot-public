import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const pub = (f: string) => resolve(__dirname, "../public", f);
const json = (f: string) => JSON.parse(readFileSync(pub(f), "utf8")) as Record<string, unknown>;

type Listener = (e: unknown) => void;

/** Запускает panel-sw.js в песочнице и отдаёт его обработчики событий. */
function loadSw() {
  const listeners: Record<string, Listener> = {};
  const self = {
    location: { origin: "https://shirinsweets.online" },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(readFileSync(pub("panel-sw.js"), "utf8"), { self, URL, caches: { match: async () => undefined, open: async () => ({ put: async () => undefined }), keys: async () => [] }, fetch: async () => ({ ok: false, type: "basic" }) });
  return listeners;
}

function fetchEvent(path: string, init: { method?: string; mode?: string; auth?: boolean; origin?: string } = {}) {
  const calls = { responded: false };
  const headers = new Map(init.auth ? [["authorization", "Bearer x"]] : []);
  const event = {
    request: {
      url: `${init.origin ?? "https://shirinsweets.online"}${path}`,
      method: init.method ?? "GET",
      mode: init.mode ?? "cors",
      headers: { has: (k: string) => headers.has(k) },
    },
    respondWith: () => (calls.responded = true),
    waitUntil: () => undefined,
  };
  return { event, calls };
}

describe("PWA панели", () => {
  const manifest = json("panel.webmanifest") as { scope: string; start_url: string; name: string; icons: { src: string }[]; display: string };
  const student = json("manifest.webmanifest") as { scope: string; start_url: string };

  it("манифест: название, область /panel/, старт внутри области, значки на месте", () => {
    expect(manifest.name).toBe("Shirin — панель");
    expect(manifest.scope).toBe("/panel/");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.display).toBe("standalone");
    for (const icon of manifest.icons) expect(() => readFileSync(pub(icon.src.split("?")[0].replace(/^\//, "")))).not.toThrow();
  });

  it("область панели не пересекается с приложением учениц", () => {
    expect(student.start_url.startsWith(manifest.scope)).toBe(false);
    expect(manifest.start_url.startsWith("/course")).toBe(false);
    const sw = readFileSync(pub("course-sw.js"), "utf8");
    expect(sw).not.toContain("/panel");
    const panelSw = readFileSync(pub("panel-sw.js"), "utf8");
    expect(panelSw).not.toContain("course-shell");
  });

  it("index.html подключает манифест панели, а не учениц", () => {
    const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
    expect(html).toContain('href="/panel.webmanifest"');
    expect(html).not.toContain("manifest.webmanifest\"");
  });

  it("nginx отдаёт service worker панели без долгого кеша", () => {
    const conf = readFileSync(resolve(__dirname, "../nginx.conf"), "utf8");
    expect(conf).toMatch(/location = \/panel-sw\.js \{[^}]*no-cache/);
  });

  it("service worker не трогает данные: API, админку, медиа, не-GET, чужие адреса, Authorization", () => {
    const sw = loadSw();
    for (const path of ["/admin/today", "/admin/v1/waiting", "/api/course/me", "/media/receipt.jpg", "/webhooks/meta", "/health", "/course", "/l/abc"]) {
      const { event, calls } = fetchEvent(path);
      sw.fetch(event);
      expect(calls.responded, path).toBe(false);
    }
    for (const init of [{ method: "POST" }, { auth: true }, { origin: "https://telegram.org" }]) {
      const { event, calls } = fetchEvent("/assets/index-abc.js", init);
      sw.fetch(event);
      expect(calls.responded).toBe(false);
    }
  });

  it("service worker берёт только оболочку: страницу панели и статику", () => {
    const sw = loadSw();
    for (const [path, mode] of [["/panel/", "navigate"], ["/panel", "navigate"], ["/assets/index-abc.js", "cors"], ["/fonts/onest.woff2", "cors"], ["/icons/icon-192.png", "no-cors"]]) {
      const { event, calls } = fetchEvent(path, { mode });
      sw.fetch(event);
      expect(calls.responded, path).toBe(true);
    }
    // обычный запрос данных на /panel/… не из навигации — не трогаем
    const { event, calls } = fetchEvent("/panel/data.json", { mode: "cors" });
    sw.fetch(event);
    expect(calls.responded).toBe(false);
  });
});
