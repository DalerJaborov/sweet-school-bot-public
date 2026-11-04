type Session = { uploadId: string; received: number; size: number; chunkBytes: number; state: string };
class UploadError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every request is small enough for Cloudflare. A lost chunk response is resolved
 * through the server offset, never by blindly appending the same bytes twice. */
export async function uploadLessonVideo(lessonId: string, file: File, token: string, progress: (percent: number) => void): Promise<void> {
  const base = `/admin/lessons/${encodeURIComponent(lessonId)}/video-uploads`;
  const headers = { Authorization: `Bearer ${token}` };
  async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method, headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) });
    const data = await res.json() as T & { error?: string };
    if (!res.ok) throw new UploadError(res.status, data.error ?? "Не удалось загрузить видео");
    return data;
  }
  if (!file.size || file.size > 2 * 1024 * 1024 * 1024) throw new Error("Выберите видео размером до 2 ГБ");
  let session = await request<Session>(base, "POST", { size: file.size, mime: file.type });
  const url = `${base}/${encodeURIComponent(session.uploadId)}`;
  let offset = 0, failures = 0, chunk = Math.min(session.chunkBytes, 4 * 1024 * 1024);
  if (!Number.isSafeInteger(chunk) || chunk <= 0) throw new Error("Сервер вернул неверный размер части");
  async function send(part: Blob): Promise<number> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PATCH", url);
      xhr.timeout = 45_000;
      xhr.setRequestHeader("Authorization", headers.Authorization);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(offset));
      xhr.upload.onprogress = (event) => progress(Math.min(99, Math.floor((offset + event.loaded) / file.size * 100)));
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText) as { received: number; error?: string };
          if (xhr.status < 200 || xhr.status >= 300) reject(new UploadError(xhr.status, data.error ?? "Не удалось отправить часть видео"));
          else resolve(data.received);
        } catch { reject(new UploadError(xhr.status, "Не удалось получить ответ сервера")); }
      };
      xhr.onerror = xhr.ontimeout = () => reject(new UploadError(0, "Связь оборвалась во время загрузки"));
      xhr.send(part);
    });
  }
  try {
    while (offset < file.size) {
      try {
        const end = Math.min(offset + chunk, file.size);
        const have = await send(file.slice(offset, end));
        if (have !== end) throw new UploadError(500, "Неверное смещение загрузки");
        offset = have; failures = 0;
      } catch (error) {
        if (error instanceof UploadError && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) throw error;
        if (++failures > 4) throw error;
        await wait(500 * 2 ** (failures - 1));
        session = await request<Session>(url, "GET");
        if (!Number.isSafeInteger(session.received) || session.received < 0 || session.received > file.size) throw new Error("Неверное смещение загрузки");
        offset = session.received;
        chunk = Math.max(256 * 1024, Math.floor(chunk / 2));
      }
    }
    for (let attempt = 0; attempt < 1200; attempt++) {
      const state = await request<{ state: string }>(`${url}/complete`, "POST", {});
      if (state.state === "done") { progress(100); return; }
      await wait(1500);
      const status = await request<Session>(url, "GET");
      if (status.state === "failed") throw new Error("Хранилище не приняло видео. Проверьте подключение хранилища и повторите загрузку");
    }
    throw new Error("Видео ещё сохраняется. Обновите список уроков через несколько минут");
  } catch (error) {
    // The server refuses cancellation while handing the complete source to storage.
    await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    throw error;
  }
}
