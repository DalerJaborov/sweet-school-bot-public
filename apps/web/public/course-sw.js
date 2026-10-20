/* eslint-disable no-undef */
/**
 * SERVICE WORKER ПЛАТФОРМЫ КУРСОВ.
 *
 * Делает три вещи.
 *
 * 1. ОБОЛОЧКА РАБОТАЕТ БЕЗ СЕТИ. Страница, стили и скрипты кладутся в кеш при
 *    установке, дальше отдаются из него. Ученица в дороге открывает приложение
 *    и видит свои уроки, а не экран «нет интернета».
 *
 * 2. ВИДЕО ИЗ ПАМЯТИ ТЕЛЕФОНА. Адреса /offline/... обслуживаются из IndexedDB,
 *    куда страница сложила сегменты, ключ, переписанный манифест, постер и
 *    фото рецепта (см. src/course/offline.ts). Плееру при этом всё равно: он
 *    видит обычный HLS.
 *
 * 3. ШРИФТ. Inter с fonts.gstatic.com кешируется после первой загрузки —
 *    иначе без сети таджикские буквы рисовались бы запасным шрифтом.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Мы не кешируем ответы API: список уроков и прогресс
 * должны быть свежими, а несвежие показали бы ученице чужую картину — например,
 * отобранный доступ выглядел бы как действующий. Офлайн-копию /me хранит сама
 * страница в IndexedDB (стор `meta`) и сама решает, когда ей верить.
 */

/**
 * ИМЯ КЕША ЖИВЁТ РОВНО ОДИН ДЕНЬ.
 *
 * Раньше здесь стояло «course-shell-v1» намертво, а activate удаляет всё
 * КРОМЕ текущего имени. После выкладки новой версии телефон ученицы продолжал
 * бы исполнять старый набор файлов при уже обновившемся сервере — от странных
 * ошибок до белого экрана, и объяснить это по переписке невозможно.
 *
 * Дата в имени решает это без сборочной магии: раз в сутки кеш оболочки
 * пересобирается сам, старые версии подчищаются в activate. Сами файлы при
 * этом отдаются «сначала сеть», так что свежая версия приезжает сразу, а кеш
 * остаётся только страховкой на случай отсутствия связи.
 */
const SHELL_CACHE = `course-shell-${new Date().toISOString().slice(0, 10)}`;
/** Шрифты живут отдельно и дольше: у них адреса с хешем, и они не меняются. */
const FONT_CACHE = "course-fonts-v1";
/** Личный манифест /api/course/app.webmanifest сюда НЕ входит: он под /api/
 *  и отдаётся только сетью — в нём токен спаривания конкретной сессии. */
const SHELL_URLS = ["/course", "/course.html"];

const DB_NAME = "sweet-school-course";
/** Согласовано с src/course/offline.ts: версия 2 добавила стор `meta`. */
const DB_VERSION = 2;
const STORE = "blobs";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      // Отсутствие одного файла не должно оставить ученицу вовсе без офлайна.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains("lessons")) db.createObjectStore("lessons", { keyPath: "lessonId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

function readBlob(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        const t = db.transaction(STORE, "readonly");
        const req = t.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
        t.oncomplete = () => db.close();
      }),
    () => undefined
  );
}

function contentTypeFor(pathname) {
  if (pathname.startsWith("/offline/manifest/")) return "application/vnd.apple.mpegurl";
  if (pathname.startsWith("/offline/key/")) return "application/octet-stream";
  // Постер и фото — JPEG: так их отдаёт перекодировка и хранилище. Браузер
  // всё равно смотрит на байты, но честный тип не помешает.
  if (pathname.startsWith("/offline/poster/") || pathname.startsWith("/offline/photo/")) return "image/jpeg";
  return "video/mp2t";
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Сохранённое видео и картинки: отдаём из памяти телефона.
  if (url.origin === self.location.origin && url.pathname.startsWith("/offline/")) {
    event.respondWith(
      readBlob(url.pathname).then((data) => {
        if (!data || data.byteLength === 0) {
          // Урока в памяти нет — честный 404, чтобы плеер сразу перешёл к
          // сетевому источнику, а не ждал таймаута.
          return new Response("not cached", { status: 404 });
        }
        return new Response(data, {
          headers: { "Content-Type": contentTypeFor(url.pathname), "Cache-Control": "no-store" },
        });
      })
    );
    return;
  }

  // API не кешируем: несвежий ответ хуже честной ошибки (см. заголовок файла).
  if (url.pathname.startsWith("/api/")) return;

  // Шрифты: сначала кеш (адреса с хешем, файл не меняется), при промахе — сеть.
  if (url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com") {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(FONT_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
            }
            return res;
          })
      )
    );
    return;
  }

  // Оболочка: сначала сеть, при неудаче — кеш. Так свежая версия приложения
  // доезжает сразу, а без сети открывается сохранённая.
  if (event.request.mode === "navigate" || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/course.html")))
    );
    return;
  }

  // Статика приложения. Имена файлов сборки содержат хеш содержимого
  // (index-DkYjZAfp.js), то есть один и тот же адрес всегда означает один и тот
  // же файл — брать его из кеша безопасно и быстро. Файлы БЕЗ хеша в имени
  // (иконки, служебные) кешируются так же, но они и меняются раз в год.
  if (url.origin === self.location.origin && /\.(js|css|woff2?|png|svg|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
            return res;
          })
      )
    );
  }
});
