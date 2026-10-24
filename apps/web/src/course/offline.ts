/**
 * ОФЛАЙН-ХРАНИЛИЩЕ УРОКОВ В ТЕЛЕФОНЕ.
 *
 * ЗАЧЕМ. У части учениц, особенно в отдалённых районах Таджикистана, интернет
 * пропадает или дорог. Урок, который уже лежит в телефоне, снимает и это, и
 * перебои CDN.
 *
 * ЧТО СОХРАНЯЕТСЯ. Только то, что человек реально смотрел, и только экономная
 * дорожка 480p: весь курс тогда занимает 2–3 ГБ вместо восьми (решение
 * владельца 03.09.2026). Кнопки «скачать» нет — открыла урок, он остался.
 *
 * КАК ЭТО РАБОТАЕТ. Сегменты, ключ и переписанный манифест кладутся в
 * IndexedDB. Service Worker перехватывает адреса вида /offline/... и отдаёт их
 * из базы, поэтому плееру всё равно, откуда пришли данные — он видит обычный
 * HLS. Подписанные ссылки на хранилище живут пять минут, и хранить их
 * бессмысленно; поэтому при загрузке манифест переписывается на локальные
 * адреса, которые не протухают.
 *
 * ОФЛАЙН — НЕ ТУПИК (03.09.2026). Раньше список уроков брался только из сети,
 * и без интернета человек видел ошибку, хотя уроки лежали в телефоне. Теперь
 * последний ответ /me хранится в сторе `meta` (версия базы 2): без сети экран
 * строится из него, а прогресс копится в очереди и уходит, когда связь
 * вернётся. Стор `meta` — простой «ключ → значение»; версия базы согласована
 * с public/course-sw.js, иначе один из них не откроет базу вовсе.
 *
 * ЧЕСТНО ПРО «НАВСЕГДА». Ни один браузер не обещает вечного хранения: кеш
 * переживает перезагрузки и месяцы, но исчезает при очистке данных или
 * нехватке места. На iOS гарантии есть только у страницы, добавленной на экран
 * «Домой». Поэтому говорим ученице «урок сохранён в телефоне», а не «навсегда».
 */

import { patchProgress, type CourseView } from "./api";

const DB_NAME = "sweet-school-course";
export const DB_VERSION = 2;
/** Сегменты, ключи, манифесты, постеры, фото. */
const STORE = "blobs";
/** Что про какой урок сохранено: размер, дата, готовность. */
const LESSONS = "lessons";
/** Ключ → значение: кэш /me, очередь прогресса, незавершённые загрузки. */
const META = "meta";

const META_ME = "me";
const META_PROGRESS = "progressQueue";
const META_PARTIALS = "partials";
/** Токен «спаривания» (дизайн доступа 03.09.2026) — см. savePair. */
const META_PAIR = "pairToken";
/** Ученица открыла хотя бы один урок — с этого момента можно предлагать установку. */
const META_LESSON_OPENED = "lessonOpened";
/** Сколько раз и когда отклоняли подсказку об установке. */
const META_INSTALL_DISMISS = "installDismiss";

export type OfflineLesson = {
  lessonId: string;
  title: string;
  segments: number;
  bytes: number;
  savedAt: number;
  /** Когда урок последний раз открывали — по этому полю вытесняем при нехватке места. */
  lastUsedAt: number;
  completed: boolean;
  /** Постер и фото рецепта лежат рядом с видео (записи старой версии их не имеют). */
  poster?: boolean;
  photos?: number;
};

export type CachedMe = { view: CourseView; savedAt: number };

export type QueuedProgress = { lessonId: string; positionSec: number; percent: number; at: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(LESSONS)) db.createObjectStore(LESSONS, { keyPath: "lessonId" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Другая вкладка держит старую версию — не висим, а честно падаем: вызовы
    // выше обёрнуты в try/catch и живут без офлайна.
    req.onblocked = () => reject(new Error("indexeddb blocked"));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onabort = () => db.close();
      }),
  );
}

export async function putBlob(key: string, data: ArrayBuffer): Promise<void> {
  await tx(STORE, "readwrite", (s) => s.put(data, key));
}

export async function getBlob(key: string): Promise<ArrayBuffer | undefined> {
  return tx<ArrayBuffer | undefined>(STORE, "readonly", (s) => s.get(key) as IDBRequest<ArrayBuffer | undefined>);
}

export async function listLessons(): Promise<OfflineLesson[]> {
  return tx<OfflineLesson[]>(LESSONS, "readonly", (s) => s.getAll() as IDBRequest<OfflineLesson[]>);
}

export async function lessonMeta(lessonId: string): Promise<OfflineLesson | undefined> {
  return tx<OfflineLesson | undefined>(
    LESSONS,
    "readonly",
    (s) => s.get(lessonId) as IDBRequest<OfflineLesson | undefined>,
  );
}

async function putLesson(meta: OfflineLesson): Promise<void> {
  await tx(LESSONS, "readwrite", (s) => s.put(meta));
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>(META, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

async function putMeta(key: string, value: unknown): Promise<void> {
  await tx(META, "readwrite", (s) => s.put(value, key));
}

async function deleteMeta(key: string): Promise<void> {
  await tx(META, "readwrite", (s) => s.delete(key));
}

/** Адреса, которые обслуживает Service Worker из хранилища телефона. */
export const offlineUrls = {
  manifest: (lessonId: string) => `/offline/manifest/${lessonId}`,
  segment: (lessonId: string, index: number) => `/offline/seg/${lessonId}/${index}.ts`,
  key: (lessonId: string) => `/offline/key/${lessonId}`,
  poster: (lessonId: string) => `/offline/poster/${lessonId}`,
  photo: (lessonId: string, index: number) => `/offline/photo/${lessonId}/${index}`,
};

// ---------- кэш /me и очередь прогресса ----------

export async function saveMe(view: CourseView): Promise<void> {
  await putMeta(META_ME, { view, savedAt: Date.now() } satisfies CachedMe);
}

export async function loadMe(): Promise<CachedMe | undefined> {
  const saved = await getMeta<CachedMe>(META_ME);
  const until = saved?.view.offlineUntil;
  return typeof until === "string" && Date.parse(until) > Date.now() ? saved : undefined;
}

/** Доступ отобрали или устройство заблокировали — сохранённая картина лжёт, стираем. */
export async function clearMe(): Promise<void> {
  await deleteMeta(META_ME);
}

// ---------- токен спаривания и подсказка об установке ----------

/**
 * ТОКЕН СПАРИВАНИЯ. Установленное на экран «Домой» приложение на iOS живёт в
 * отдельном хранилище от Safari: куки сессии туда не переезжают. Поэтому
 * личный манифест (/api/course/app.webmanifest) кладёт в start_url
 * `?pair=<токен>` — открывшись, приложение обменивает его на те же сессионные
 * куки ДЛЯ ТОГО ЖЕ устройства, не занимая нового места в лимите. Токен
 * храним здесь, чтобы api.ts мог повторить обмен, если куки пропали
 * (iOS чистит их у редко открываемых приложений).
 */
export async function savePair(token: string): Promise<void> {
  await putMeta(META_PAIR, token);
}

export async function loadPair(): Promise<string | undefined> {
  return getMeta<string>(META_PAIR);
}

/** Доступ отобрали или устройство заблокировали — токен больше ничего не даёт. */
export async function clearPair(): Promise<void> {
  await deleteMeta(META_PAIR);
}

export type InstallDismiss = { count: number; at: number };

export async function markLessonOpened(): Promise<void> {
  await putMeta(META_LESSON_OPENED, true);
}

export async function wasLessonOpened(): Promise<boolean> {
  return (await getMeta<boolean>(META_LESSON_OPENED)) === true;
}

export async function loadInstallDismiss(): Promise<InstallDismiss | undefined> {
  return getMeta<InstallDismiss>(META_INSTALL_DISMISS);
}

export async function dismissInstall(now = Date.now()): Promise<InstallDismiss> {
  const prev = await loadInstallDismiss();
  const next = { count: (prev?.count ?? 0) + 1, at: now };
  await putMeta(META_INSTALL_DISMISS, next);
  return next;
}

/**
 * Прогресс без сети: правим сохранённый /me на месте, чтобы после перезапуска
 * без интернета чипы «продолжить с 12:30» были честными, а не вчерашними.
 */
export async function updateCachedProgress(lessonId: string, positionSec: number, percent: number): Promise<void> {
  const cached = await loadMe();
  if (!cached) return;
  const view = patchProgress(cached.view, lessonId, positionSec, percent);
  await putMeta(META_ME, { view, savedAt: cached.savedAt } satisfies CachedMe);
}

export async function enqueueProgress(item: QueuedProgress): Promise<void> {
  const queue = (await getMeta<QueuedProgress[]>(META_PROGRESS)) ?? [];
  // На один урок — одна запись, последняя: серверу нужна только конечная точка.
  const rest = queue.filter((q) => q.lessonId !== item.lessonId);
  await putMeta(META_PROGRESS, [...rest, item]);
}

/**
 * Слить очередь при появлении сети. Неудачная отправка оставляет запись на
 * месте: попробуем при следующем `online`.
 */
export async function flushProgressQueue(
  send: (item: QueuedProgress) => Promise<unknown>,
): Promise<{ sent: number; left: number }> {
  const queue = (await getMeta<QueuedProgress[]>(META_PROGRESS)) ?? [];
  if (queue.length === 0) return { sent: 0, left: 0 };
  const left: QueuedProgress[] = [];
  let sent = 0;
  for (const item of queue) {
    try {
      await send(item);
      sent++;
    } catch {
      left.push(item);
    }
  }
  if (left.length === 0) await deleteMeta(META_PROGRESS);
  else await putMeta(META_PROGRESS, left);
  return { sent, left: left.length };
}

// ---------- незавершённые загрузки ----------

type Partials = Record<string, { segments: number; photos: number }>;

async function markPartial(lessonId: string, segments: number, photos: number): Promise<void> {
  const partials = (await getMeta<Partials>(META_PARTIALS)) ?? {};
  await putMeta(META_PARTIALS, { ...partials, [lessonId]: { segments, photos } });
}

async function unmarkPartial(lessonId: string): Promise<void> {
  const partials = (await getMeta<Partials>(META_PARTIALS)) ?? {};
  if (!(lessonId in partials)) return;
  const { [lessonId]: _dropped, ...rest } = partials;
  void _dropped;
  await putMeta(META_PARTIALS, rest);
}

async function deleteLessonBlobs(lessonId: string, segments: number, photos: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const t = db.transaction(STORE, "readwrite");
    const blobs = t.objectStore(STORE);
    blobs.delete(offlineUrls.manifest(lessonId));
    blobs.delete(offlineUrls.key(lessonId));
    blobs.delete(offlineUrls.poster(lessonId));
    for (let i = 0; i < segments; i++) blobs.delete(offlineUrls.segment(lessonId, i));
    for (let i = 0; i < photos; i++) blobs.delete(offlineUrls.photo(lessonId, i));
    const done = () => {
      db.close();
      resolve();
    };
    t.oncomplete = done;
    t.onabort = done;
    t.onerror = done;
  });
}

/**
 * Убрать хвосты оборванных загрузок. Раньше сегменты половины урока лежали в
 * базе навсегда: записи об уроке нет, а место занято. Вызывается при старте;
 * сама загрузка тоже чистит за собой при неудаче, sweep — страховка на случай,
 * когда вкладку закрыли посреди процесса.
 */
export async function sweepPartials(): Promise<number> {
  const partials = (await getMeta<Partials>(META_PARTIALS)) ?? {};
  const ids = Object.keys(partials);
  for (const id of ids) {
    const { segments, photos } = partials[id];
    await deleteLessonBlobs(id, segments, photos);
  }
  if (ids.length > 0) await deleteMeta(META_PARTIALS);
  return ids.length;
}

// ---------- хранилище браузера ----------

/**
 * Попросить у браузера постоянное хранилище. Без этого разрешения браузер
 * вправе вычистить кеш, когда на телефоне кончается место, — и урок исчезнет
 * ровно тогда, когда он нужнее всего. Отказ не фатален: просто живём как есть.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Сколько места занято и сколько доступно — для честной строки «память». */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

// ---------- загрузка урока ----------

type DownloadInput = {
  lessonId: string;
  keyUrl: string;
  variantUrl: string;
  segments: string[];
  /** Постер и фото рецепта — чтобы экран урока без сети не был пустым. */
  posterUrl?: string | null;
  photoUrls?: string[];
};

/**
 * Скачать урок целиком. Идёт последовательно, а не всеми запросами разом: на
 * слабой связи двадцать параллельных загрузок мешают друг другу и рвутся, а
 * ещё это единственный трафик ученицы, и забивать ей канал нельзя.
 */
export async function downloadLesson(
  payload: DownloadInput,
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const { lessonId, segments } = payload;
  const photoUrls = payload.photoUrls ?? [];
  try {
    await markPartial(lessonId, segments.length, photoUrls.length);

    // Ключ расшифровки: без него скачанные сегменты бесполезны, поэтому он
    // первым — если сеть оборвётся дальше, незачем хранить половину урока.
    const keyRes = await fetch(payload.keyUrl, { credentials: "include" });
    if (!keyRes.ok) throw new Error("key");
    await putBlob(offlineUrls.key(lessonId), await keyRes.arrayBuffer());

    // Манифест переписываем на локальные адреса: подписанные ссылки на
    // хранилище живут пять минут и офлайн бесполезны.
    const manifestRes = await fetch(payload.variantUrl, { credentials: "include" });
    if (!manifestRes.ok) throw new Error("manifest");
    const rewritten = rewriteManifest(await manifestRes.text(), lessonId);
    await putBlob(offlineUrls.manifest(lessonId), new TextEncoder().encode(rewritten).buffer as ArrayBuffer);

    let bytes = 0;
    for (let i = 0; i < segments.length; i++) {
      const res = await fetch(segments[i]);
      if (!res.ok) throw new Error("segment");
      const buf = await res.arrayBuffer();
      bytes += buf.byteLength;
      await putBlob(offlineUrls.segment(lessonId, i), buf);
      onProgress?.(i + 1, segments.length);
    }

    // Картинки — по возможности: без них урок всё равно смотрится, и падать
    // из-за фото нельзя.
    const poster = await fetchImage(payload.posterUrl ?? null, offlineUrls.poster(lessonId));
    let photos = 0;
    for (let i = 0; i < photoUrls.length; i++) {
      if (await fetchImage(photoUrls[i], offlineUrls.photo(lessonId, i))) photos = i + 1;
      else break;
    }

    await putLesson({
      lessonId,
      title,
      segments: segments.length,
      bytes,
      savedAt: Date.now(),
      lastUsedAt: Date.now(),
      completed: false,
      poster,
      photos,
    });
    await unmarkPartial(lessonId);
    return true;
  } catch {
    // Оборвалась связь — не оставляем половину урока в базе. В следующий раз
    // попробуем снова.
    await deleteLessonBlobs(lessonId, segments.length, photoUrls.length).catch(() => undefined);
    await unmarkPartial(lessonId).catch(() => undefined);
    return false;
  }
}

async function fetchImage(url: string | null, key: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    await putBlob(key, await res.arrayBuffer());
    return true;
  } catch {
    return false;
  }
}

/** Замена адресов в манифесте на локальные: сегменты по порядку, ключ по уроку. */
export function rewriteManifest(text: string, lessonId: string): string {
  let index = 0;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#EXT-X-KEY")) {
        return trimmed.replace(/URI="[^"]*"/, `URI="${offlineUrls.key(lessonId)}"`);
      }
      if (trimmed.startsWith("#")) return line;
      return offlineUrls.segment(lessonId, index++);
    })
    .join("\n");
}

export async function markUsed(lessonId: string): Promise<void> {
  const meta = await lessonMeta(lessonId);
  if (meta) await putLesson({ ...meta, lastUsedAt: Date.now() });
}

export async function markCompleted(lessonId: string): Promise<void> {
  const meta = await lessonMeta(lessonId);
  if (meta && !meta.completed) await putLesson({ ...meta, completed: true });
}

export async function removeLesson(lessonId: string): Promise<void> {
  const meta = await lessonMeta(lessonId);
  if (!meta) return;
  // Пустой ключ первым: если плеер в этот момент читает урок, он получит
  // честный 404 от SW, а не половину сегментов.
  await putBlob(offlineUrls.key(lessonId), new ArrayBuffer(0));
  await deleteLessonBlobs(lessonId, meta.segments, meta.photos ?? 0);
  await tx(LESSONS, "readwrite", (s) => s.delete(lessonId));
}

/**
 * Освободить место под новый урок.
 *
 * Порядок вытеснения: сначала досмотренные (к ним возвращаются реже), потом
 * те, что дольше всех не открывали. Так у ученицы остаётся именно то, что она
 * сейчас проходит.
 */
export async function evictIfNeeded(neededBytes: number): Promise<void> {
  const estimate = await storageEstimate();
  if (!estimate || estimate.quota === 0) return;
  // Держим десятую часть квоты свободной: браузер начинает чистить сам задолго
  // до нуля, и лучше решить, что удалить, самим.
  const free = estimate.quota - estimate.usage - estimate.quota * 0.1;
  if (free >= neededBytes) return;

  const lessons = (await listLessons()).sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? -1 : 1;
    return a.lastUsedAt - b.lastUsedAt;
  });

  let freed = 0;
  for (const lesson of lessons) {
    if (freed >= neededBytes - free) break;
    await removeLesson(lesson.lessonId);
    freed += lesson.bytes;
  }
}

/** Регистрация Service Worker. Без него офлайн не работает вовсе, но само
 *  приложение продолжает жить онлайн — поэтому ошибка не критична. */
export async function registerServiceWorker(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.register("/course-sw.js", { scope: "/" });
    return true;
  } catch {
    return false;
  }
}
