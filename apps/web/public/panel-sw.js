/* eslint-disable no-undef */
/**
 * SERVICE WORKER ПАНЕЛИ (область /panel/).
 *
 * ЗАЧЕМ. Панель ставится на телефон как приложение. Без сети она должна не
 * исчезать белым экраном, а открыться и честно сказать «нет связи».
 *
 * ЧТО КЕШИРУЕТ — ТОЛЬКО ОБОЛОЧКУ:
 *   1. страницу /panel/ (пустой каркас без единой цифры клиента);
 *   2. статику с хешем в имени: /assets/*, /fonts/*, /icons/*, значки.
 *
 * ЧЕГО НЕ ДЕЛАЕТ НИКОГДА. Не трогает /admin/, /api/, /media/, /webhooks/,
 * /health и любые запросы не GET, чужие адреса, запросы с заголовком
 * Authorization. Чеки, клиенты и деньги всегда приходят с сервера свежими:
 * устаревшая копия показала бы сестре чек, который уже подтверждён.
 *
 * ОТДЕЛЕН от course-sw.js (платформа учениц, область "/"): панель живёт под
 * /panel/, и браузер выбирает service worker с самой длинной подходящей
 * областью, поэтому в панели работает этот, а у учениц — тот. Файл лежит в
 * корне, nginx отдаёт его без долгого кеша (nginx.conf → /panel-sw.js).
 */
const SHELL_CACHE = "panel-shell-v1";
const SHELL_URL = "/panel/";
const STATIC_PREFIXES = ["/assets/", "/fonts/", "/icons/"];
const STATIC_FILES = ["/icon-192.png", "/icon-512.png", "/favicon.svg", "/favicon.ico"];
const NEVER_PREFIXES = [
  "/admin",
  "/admin-form",
  "/api",
  "/media",
  "/webhooks",
  "/health",
  "/course",
  "/l/",
  "/cdn-cgi",
];

/**
 * Что делать с запросом: "shell" (страница панели), "static" (файл с хешем) или
 * null — не вмешиваться вовсе, браузер идёт в сеть как обычно.
 */
function classify(url, request) {
  if (request.method !== "GET") return null;
  if (url.origin !== self.location.origin) return null;
  if (request.headers && request.headers.has("authorization")) return null;
  const path = url.pathname;
  if (NEVER_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"))) return null;
  if (request.mode === "navigate" && (path === "/panel" || path === "/panel/")) return "shell";
  if (STATIC_PREFIXES.some((p) => path.startsWith(p)) || STATIC_FILES.includes(path)) return "static";
  return null;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("panel-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const kind = classify(new URL(event.request.url), event.request);
  if (!kind) return;

  if (kind === "shell") {
    // Сначала сеть: свежая версия приезжает сразу; кеш — только на случай,
    // когда связи нет.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(SHELL_URL, copy)));
          }
          return res;
        } catch (err) {
          const cached = await caches.match(SHELL_URL);
          if (cached) return cached;
          throw err;
        }
      })(),
    );
    return;
  }

  // Статика: файлы с хешем не меняются, поэтому сначала память, потом сеть.
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy)));
      }
      return res;
    })(),
  );
});
