import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { getSetting, logError } from "../db.js";

/**
 * S3-СОВМЕСТИМОЕ ХРАНИЛИЩЕ (Cloudflare R2).
 *
 * ПОЧЕМУ СВОЯ ПОДПИСЬ, А НЕ AWS SDK. Нам нужны четыре операции (положить,
 * забрать, удалить, перечислить) и подписанные ссылки. `@aws-sdk/client-s3`
 * тянет за собой десятки пакетов и десятки мегабайт в образ ради этого —
 * несоразмерно. SigV4 это сто строк на node:crypto, и они здесь.
 *
 * ПОЧЕМУ ИМЕННО S3-ИНТЕРФЕЙС, А НЕ API CLOUDFLARE. Владелец выбрал R2, зная
 * риск: в России Cloudflare периодически режут через DPI (проверка 03.09.2026,
 * см. docs/course-platform-design.md §5.2). Переезд на Yandex Object Storage
 * должен стоить смены четырёх настроек, а не переписывания — поэтому ни одного
 * вызова, специфичного для Cloudflare, здесь нет.
 *
 * Ключи берутся из настроек панели, а не из окружения: владелец вставляет их
 * сам той же формой, что маркеры Meta, и они маскируются в выдаче.
 */

const SERVICE = "s3";
/** Подпись без хеша тела — для потоковой отправки, где читать файл ради хеша
 *  значило бы вернуть ту самую загрузку в память, от которой уходим. */
const UNSIGNED = "UNSIGNED-PAYLOAD";
/** Потолок на загрузку и скачивание крупного файла: два гигабайта по мобильной
 *  сети идут долго, но не бесконечно. */
const UPLOAD_TIMEOUT_MS = 60 * 60_000;
/** R2 не использует регионы, но SigV4 требует что-то подписать. "auto" —
 *  значение, которое ждёт сам R2; для Yandex сюда пойдёт "ru-central1". */
const DEFAULT_REGION = "auto";
const TIMEOUT_MS = 60_000;

export type StorageConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Публичный адрес раздачи (CDN или r2.dev). Пусто — раздаём подписанными
   *  ссылками прямо на endpoint. */
  publicBase: string;
};

/** Настройки хранилища из панели. null — не настроено, вызывающий код обязан
 *  сказать об этом человеку, а не падать. */
export async function storageConfig(): Promise<StorageConfig | null> {
  const endpoint = (await getSetting("r2Endpoint"))?.trim() ?? "";
  const bucket = (await getSetting("r2Bucket"))?.trim() ?? "";
  const accessKeyId = (await getSetting("r2AccessKeyId"))?.trim() ?? "";
  const secretAccessKey = (await getSetting("r2SecretKey"))?.trim() ?? "";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    region: (await getSetting("r2Region"))?.trim() || DEFAULT_REGION,
    publicBase: ((await getSetting("r2PublicBase"))?.trim() ?? "").replace(/\/+$/, ""),
  };
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** Кодирование пути по правилам AWS: слеши между сегментами остаются, всё
 *  остальное экранируется. encodeURIComponent не трогает ! ' ( ) * — а подпись
 *  считается по строгому варианту, иначе ссылка ломается на таких именах. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

/** Ключ подписи выводится из секрета по цепочке дата → регион → сервис. */
function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), SERVICE), "aws4_request");
}

function amzDate(now: Date): { full: string; short: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { full, short: full.slice(0, 8) };
}

/**
 * ПОДПИСАННАЯ ССЫЛКА НА ЧТЕНИЕ. Живёт `expiresSec` секунд, дальше мертва.
 *
 * Так плеер тянет сегменты НАПРЯМУЮ из хранилища через CDN, минуя наш сервер:
 * гнать 8 ГБ видео через VPS школы было бы и дорого, и медленно. Утечка самой
 * ссылки не страшна — сегменты зашифрованы AES-128, а ключ отдаёт наш сервер
 * после проверки устройства (см. src/course/lessonAccess.ts).
 */
export function presignGet(cfg: StorageConfig, key: string, expiresSec = 300, now = new Date()): string {
  const { full, short } = amzDate(now);
  const host = new URL(cfg.endpoint).host;
  const credential = `${cfg.accessKeyId}/${short}/${cfg.region}/${SERVICE}/aws4_request`;

  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": full,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
  });
  // Порядок параметров в канонической строке обязан быть лексикографическим.
  query.sort();

  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    query.toString(),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    full,
    `${short}/${cfg.region}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(cfg.secretAccessKey, short, cfg.region), stringToSign).toString("hex");
  return `${cfg.endpoint}${canonicalUri}?${query.toString()}&X-Amz-Signature=${signature}`;
}

/** Заголовки авторизации для обычного запроса (загрузка, удаление, список). */
function authHeaders(
  cfg: StorageConfig,
  method: string,
  canonicalUri: string,
  queryString: string,
  payload: Buffer | typeof UNSIGNED,
  extraHeaders: Record<string, string>,
  now: Date
): Record<string, string> {
  const { full, short } = amzDate(now);
  const host = new URL(cfg.endpoint).host;
  // Строка UNSIGNED-PAYLOAD подставляется вместо хеша как есть — так устроен
  // сам протокол, это не заглушка.
  const payloadHash = payload === UNSIGNED ? UNSIGNED : sha256Hex(payload);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": full,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    full,
    `${short}/${cfg.region}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmac(signingKey(cfg.secretAccessKey, short, cfg.region), stringToSign).toString("hex");

  return {
    ...extraHeaders,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": full,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${short}/${cfg.region}/${SERVICE}/aws4_request, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * ПОЛОЖИТЬ БОЛЬШОЙ ФАЙЛ ПОТОКОМ, НЕ ЧИТАЯ ЕГО В ПАМЯТЬ.
 *
 * Обычный putObject держит всё тело в буфере, да ещё и копирует его вторым
 * массивом при отправке. Для урока на два гигабайта это гарантированный обрыв
 * по нехватке памяти: процесс убивают, контейнер перезапускается, и вместе с
 * ним теряются накопленные ответы клиенткам и очередь перекодировки.
 *
 * Подпись считается с UNSIGNED-PAYLOAD: R2 это принимает, а иначе пришлось бы
 * прочитать файл целиком ради одного хеша — то есть ровно то, чего избегаем.
 * Целостность при этом обеспечивает сам TLS, а доступ — подпись заголовков.
 */
export async function putObjectStream(
  cfg: StorageConfig,
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const size = (await fs.promises.stat(filePath)).size;
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = authHeaders(
    cfg,
    "PUT",
    canonicalUri,
    "",
    UNSIGNED,
    { "content-type": contentType, "cache-control": "private, max-age=0", "content-length": String(size) },
    new Date()
  );

  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: "PUT",
    headers,
    body: Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream,
    // duplex обязателен для потокового тела в fetch Node — без него запрос
    // отклоняется ещё до отправки.
    duplex: "half",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  } as RequestInit & { duplex: "half" });

  if (!res.ok) {
    throw new Error(`Хранилище отказало на загрузке ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * СКАЧАТЬ БОЛЬШОЙ ФАЙЛ ПРЯМО НА ДИСК, минуя память. Симметрично putObjectStream:
 * исходник урока в getObject целиком не помещается.
 */
export async function getObjectToFile(cfg: StorageConfig, key: string, filePath: string): Promise<boolean> {
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = authHeaders(cfg, "GET", canonicalUri, "", Buffer.alloc(0), {}, new Date());
  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (res.status === 404) return false;
  if (!res.ok || !res.body) throw new Error(`Хранилище отказало на чтении ${key}: ${res.status}`);

  await fs.promises.writeFile(filePath, Readable.fromWeb(res.body as never));
  return true;
}

/** Положить объект. `contentType` важен: браузер откажется играть манифест,
 *  отданный как application/octet-stream. */
export async function putObject(
  cfg: StorageConfig,
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl = "public, max-age=31536000, immutable"
): Promise<void> {
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = authHeaders(
    cfg,
    "PUT",
    canonicalUri,
    "",
    body,
    { "content-type": contentType, "cache-control": cacheControl },
    new Date()
  );
  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: "PUT",
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Хранилище отказало на загрузке ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export async function getObject(cfg: StorageConfig, key: string): Promise<Buffer | null> {
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = authHeaders(cfg, "GET", canonicalUri, "", Buffer.alloc(0), {}, new Date());
  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Хранилище отказало на чтении ${key}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * CORS НА БАКЕТЕ. Сегменты видео и картинки раздаются подписанными ссылками
 * прямо с R2, и hls.js тянет их XHR-ом с нашего домена — без CORS браузер
 * такие ответы не отдаёт. Safari с нативным HLS этого не замечал, а Chrome на
 * Android не загрузил бы ни одного сегмента (поймано 03.09.2026 живьём).
 * Ставится один раз из контейнера; повторный вызов безопасен.
 */
export async function putBucketCors(cfg: StorageConfig, origins: string[]): Promise<void> {
  const rules = origins
    .map(
      (o) =>
        `<CORSRule><AllowedOrigin>${o}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>` +
        `<AllowedHeader>*</AllowedHeader><ExposeHeader>Content-Length</ExposeHeader><ExposeHeader>Content-Range</ExposeHeader><MaxAgeSeconds>86400</MaxAgeSeconds></CORSRule>`
    )
    .join("");
  const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration>${rules}</CORSConfiguration>`);
  const canonicalUri = `/${cfg.bucket}/`;
  const md5 = crypto.createHash("md5").update(body).digest("base64");
  const headers = authHeaders(cfg, "PUT", canonicalUri, "cors=", body, { "content-md5": md5, "content-type": "application/xml" }, new Date());
  const res = await fetch(`${cfg.endpoint}${canonicalUri}?cors`, {
    method: "PUT",
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Хранилище отказало на CORS: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function deleteObject(cfg: StorageConfig, key: string): Promise<void> {
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = authHeaders(cfg, "DELETE", canonicalUri, "", Buffer.alloc(0), {}, new Date());
  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 204 — удалено, 404 — уже не было; и то и другое означает «объекта нет».
  if (!res.ok && res.status !== 404) {
    throw new Error(`Хранилище отказало на удалении ${key}: ${res.status}`);
  }
}

/**
 * СПИСОК БАКЕТОВ, ДОСТУПНЫХ ЭТИМ КЛЮЧАМ.
 *
 * Нужен, чтобы не угадывать имя хранилища по тексту страницы Cloudflare.
 * Угадывание уже подвело живьём (03.09.2026): на странице стояло
 * «Specify bucket(s)», и в настройку уехало слово «buckets» — ключи при этом
 * были верные, а хранилище отвечало «NoSuchBucket», и по этой ошибке
 * невозможно было понять, что не так именно с именем.
 *
 * Спрашиваем у самого хранилища: оно знает точно. Токен, выданный на один
 * бакет, вернёт ровно его.
 *
 * Подпись считается для корня, поэтому bucket в cfg тут не участвует — этот
 * запрос как раз и нужен, когда правильное имя ещё неизвестно.
 */
export async function listBuckets(cfg: StorageConfig): Promise<string[]> {
  const headers = authHeaders(cfg, "GET", "/", "", Buffer.alloc(0), {}, new Date());
  const res = await fetch(`${cfg.endpoint}/`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Хранилище отказало на списке бакетов: ${res.status}`);
  const xml = await res.text();
  // Разбирать XML целиком незачем: нужен один повторяющийся тег, а тянуть
  // ради него зависимость-парсер — лишний вес в образе.
  return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
}

/**
 * Публичный адрес объекта, если раздача настроена (CDN или r2.dev). Такие
 * ссылки не протухают и годятся для картинок рецепта и обложек, но НЕ для
 * сегментов видео — тем нужна подпись с коротким сроком.
 */
export function publicUrl(cfg: StorageConfig, key: string): string | null {
  return cfg.publicBase ? `${cfg.publicBase}/${encodeKey(key)}` : null;
}

/**
 * ПРОВЕРКА ДОСТУПНОСТИ ХРАНИЛИЩА — обязательное смягчение риска R2 (§5.2).
 *
 * Раз в час дёргает служебный объект и, если два раза подряд не вышло, пишет в
 * лог тревогу: про перебои CDN владелец должен узнавать от бота, а не от
 * ученицы, которая не смогла открыть урок.
 */
let consecutiveFailures = 0;

export async function checkStorageReachable(): Promise<{ ok: boolean; detail: string }> {
  const cfg = await storageConfig();
  if (!cfg) return { ok: false, detail: "хранилище не настроено" };
  const probeKey = "health/probe.txt";
  try {
    // Пишем и читаем: чтение своего же свежего объекта проверяет всю цепочку.
    await putObject(cfg, probeKey, Buffer.from(String(Date.now())), "text/plain", "no-store");
    const back = await getObject(cfg, probeKey);
    if (!back) throw new Error("объект записан, но не читается");
    consecutiveFailures = 0;
    return { ok: true, detail: "хранилище отвечает" };
  } catch (err) {
    consecutiveFailures += 1;
    const detail = err instanceof Error ? err.message : String(err);
    if (consecutiveFailures >= 2) {
      logError("storage:unreachable", new Error(`${consecutiveFailures} проверки подряд не прошли: ${detail}`));
    }
    return { ok: false, detail };
  }
}

/** Для тестов: сбросить счётчик подряд идущих отказов. */
export function resetStorageFailures(): void {
  consecutiveFailures = 0;
}
