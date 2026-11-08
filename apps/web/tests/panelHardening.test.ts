import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { loadWithReload, RELOAD_FLAG } from "../src/panel/lazy";

const root = (f: string) => resolve(__dirname, "..", f);
const text = (f: string) => readFileSync(root(f), "utf8");

afterEach(() => sessionStorage.clear());

describe("устаревшая вкладка после выкладки", () => {
  it("первая ошибка загрузки раздела — одна перезагрузка и флаг", async () => {
    const reload = vi.fn();
    const p = loadWithReload(() => Promise.reject(new Error("404 chunk")), reload);
    // промис не завершается, пока страница перезагружается
    const settled = await Promise.race([
      p.then(
        () => "done",
        () => "error",
      ),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe("1");
  });

  it("вторая ошибка подряд — не зацикливаемся, ошибка доходит до экрана", async () => {
    sessionStorage.setItem(RELOAD_FLAG, "1");
    const reload = vi.fn();
    await expect(loadWithReload(() => Promise.reject(new Error("offline")), reload)).rejects.toThrow("offline");
    expect(reload).not.toHaveBeenCalled();
  });

  it("успешная загрузка снимает флаг", async () => {
    sessionStorage.setItem(RELOAD_FLAG, "1");
    await expect(loadWithReload(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
  });

  it("nginx: index.html без долгого кеша, правило до location /", () => {
    const conf = text("nginx.conf");
    const exact = conf.indexOf("location = /index.html");
    expect(exact).toBeGreaterThan(0);
    expect(conf.slice(exact, exact + 120)).toContain("no-cache");
    expect(exact).toBeLessThan(conf.indexOf("    location / {"));
  });

  it("index.html: meta charset — первая строка head", () => {
    const html = text("index.html");
    expect(
      html
        .slice(html.indexOf("<head>") + 6)
        .trimStart()
        .startsWith('<meta charset="UTF-8"'),
    ).toBe(true);
    expect(html.indexOf("<meta charset")).toBeLessThan(1024);
  });
});

/** Запуск service worker в песочнице с набором «чужих» и «своих» кешей. */
function runActivate(file: string, names: string[]) {
  const deleted: string[] = [];
  const listeners: Record<string, (e: { waitUntil: (p: Promise<unknown>) => void }) => void> = {};
  const self = {
    location: { origin: "https://x" },
    addEventListener: (t: string, fn: (e: never) => void) => (listeners[t] = fn as never),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = {
    keys: async () => names,
    delete: async (n: string) => void deleted.push(n),
    open: async () => ({
      addAll: async () => undefined,
      put: async () => undefined,
      keys: async () => [],
      delete: async () => true,
    }),
    match: async () => undefined,
  };
  vm.runInNewContext(text(file), { self, caches, URL, Date, indexedDB: {}, fetch: async () => undefined, console });
  let pending: Promise<unknown> = Promise.resolve();
  listeners.activate({ waitUntil: (p) => (pending = p) });
  return pending.then(() => deleted);
}

describe("service worker: кеши не мешают друг другу", () => {
  const all = [
    "course-shell-2026-01-01",
    "course-shell-2020-01-01",
    "course-fonts-v1",
    "panel-shell-v1",
    "panel-shell-v2",
    "other-app",
  ];

  it("ученицы чистят только свои старые кеши (course-*), не панельные и не чужие", async () => {
    const deleted = await runActivate("public/course-sw.js", all);
    expect(deleted).not.toContain("panel-shell-v1");
    expect(deleted).not.toContain("panel-shell-v2");
    expect(deleted).not.toContain("other-app");
    expect(deleted).toContain("course-shell-2020-01-01");
  });

  it("панель удаляет только старые panel-*, не course-* и не чужие", async () => {
    const deleted = await runActivate("public/panel-sw.js", all);
    expect(deleted).toEqual(["panel-shell-v1"]);
  });
});
