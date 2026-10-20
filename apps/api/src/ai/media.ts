import { geminiUrl, geminiProxyHeaders, throughProxy, RETRY_DELAYS_MS, isRetryableStatus, sleep } from "../gemini.js";
import { logError } from "../db.js";

const FETCH_TIMEOUT_MS = 20_000;
/** Ссылки, которые уходят через safeFetch-подобные проверки в CRM, здесь приходят
 *  напрямую из вебхука Meta — доверяем источнику, но не размеру: 25 МБ отсекают
 *  случайно присланный тяжёлый файл до того, как он ляжет в память процесса. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type Attachment = { url: string; kind: "image" | "video" | "audio" | "file" };

/**
 * Живой случай 05.09.2026 (@lazina_0101): она прислала скриншот оплаты, скачать
 * его не вышло за 20 с (CDN Instagram отдал файл медленно) — фото потерялось
 * молча, вложения не осталось нигде, а разговор продолжился так, будто ничего
 * не приходило. Один быстрый повтор почти всегда снимает именно эту причину
 * (короткая задержка CDN, а не настоящий сбой сети).
 */
async function fetchOnce(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_ATTACHMENT_BYTES) throw new Error(`файл слишком большой (${Math.round(len / 1_000_000)} МБ)`);
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("файл слишком большой");
    return { buffer, mimeType };
  } finally {
    clearTimeout(timer);
  }
}

/** Скачивает вложение по ссылке из вебхука. null — не смогли (сеть, слишком большой файл). */
export async function fetchAttachment(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    return await fetchOnce(url);
  } catch (firstErr) {
    // Один повтор сразу, без паузы: чек клиентки дороже секунды лишнего ожидания,
    // а вторая попытка почти всегда успевает, если файл был просто не готов.
    try {
      return await fetchOnce(url);
    } catch (err) {
      logError("media:fetch", err);
      logError("media:fetch:firstAttempt", firstErr);
      return null;
    }
  }
}

/** Крупнее — только через File API: base64 раздувает файл на треть, а весь запрос
 *  Gemini обязан уместиться в 20 МБ. */
const INLINE_MAX_BYTES = 12 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const STATE_TIMEOUT_MS = 15_000;
const PROCESSING_WAIT_MS = 45_000;
const PROCESSING_POLL_MS = 3_000;

export type MediaPart = { inline_data: { mime_type: string; data: string } } | { file_data: { mime_type: string; file_uri: string } };

/** Готовит часть запроса к Gemini: маленький файл — прямо в тело (inline), крупное
 *  видео — через File API (заливка + ожидание готовности). null — не осилили. */
export async function buildMediaPart(buffer: Buffer, mimeType: string, apiKey: string): Promise<MediaPart | null> {
  if (buffer.byteLength <= INLINE_MAX_BYTES) {
    return { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } };
  }
  return uploadAndWait(buffer, mimeType, apiKey);
}

async function uploadAndWait(buffer: Buffer, mimeType: string, apiKey: string): Promise<MediaPart | null> {
  const headers = { "x-goog-api-key": apiKey, ...geminiProxyHeaders() };
  try {
    let uploadUrl: string | null = null;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      const start = await fetch(geminiUrl("/upload/v1beta/files"), {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(buffer.byteLength),
          "X-Goog-Upload-Header-Content-Type": mimeType,
        },
        body: JSON.stringify({ file: { display_name: "attachment" } }),
        signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
      });
      if (!start.ok) {
        if (!isRetryableStatus(start.status)) throw new Error(`File API старт HTTP ${start.status}`);
        continue;
      }
      uploadUrl = start.headers.get("x-goog-upload-url");
      if (uploadUrl) break;
    }
    if (!uploadUrl) throw new Error("File API не вернул адрес загрузки");

    const uploaded = await fetch(throughProxy(uploadUrl), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(buffer.byteLength),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!uploaded.ok) throw new Error(`File API заливка HTTP ${uploaded.status}`);

    const info = (await uploaded.json()) as { file?: { uri?: string; name?: string; state?: string } };
    const uri = info.file?.uri;
    const name = info.file?.name;
    if (!uri || !name) throw new Error("File API не вернул адрес файла");

    let state = info.file?.state ?? "PROCESSING";
    const deadline = Date.now() + PROCESSING_WAIT_MS;
    while (state === "PROCESSING") {
      if (Date.now() > deadline) throw new Error("File API не подготовил файл вовремя");
      await sleep(PROCESSING_POLL_MS);
      const check = await fetch(geminiUrl(`/v1beta/${name}`), { headers, signal: AbortSignal.timeout(STATE_TIMEOUT_MS) });
      if (!check.ok) throw new Error(`File API состояние HTTP ${check.status}`);
      state = ((await check.json()) as { state?: string }).state ?? "PROCESSING";
    }
    if (state !== "ACTIVE") throw new Error(`File API вернул состояние ${state}`);

    return { file_data: { mime_type: mimeType, file_uri: uri } };
  } catch (err) {
    logError("media:upload", err);
    return null;
  }
}
