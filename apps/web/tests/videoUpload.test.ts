import { afterEach, expect, it, vi } from "vitest";
import { uploadLessonVideo } from "../src/videoUpload";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("splits video and resumes from the server offset after a lost chunk response", async () => {
  vi.useFakeTimers();
  let received = 0, lose = true;
  const offsets: number[] = [], sizes: number[] = [];
  class Xhr {
    status = 200; responseText = ""; timeout = 0;
    upload = { onprogress: (_e: { loaded: number }) => {} };
    onload = () => {}; onerror = () => {}; ontimeout = () => {};
    headers: Record<string, string> = {};
    open(method: string, url: string) { expect(method).toBe("PATCH"); expect(url).toContain("/video-uploads/session"); }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send(body: Blob) {
      expect(this.headers.Authorization).toBe("Bearer private-test-token");
      offsets.push(Number(this.headers["Upload-Offset"])); sizes.push(body.size);
      expect(offsets.at(-1)).toBe(received); received += body.size;
      if (lose) { lose = false; this.onerror(); return; }
      this.responseText = JSON.stringify({ received }); this.onload();
    }
  }
  vi.stubGlobal("XMLHttpRequest", Xhr);
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => init.method === "GET" ? { received } : String(_url).endsWith("complete") ? { state: "done" } : { uploadId: "session", chunkBytes: 4 * 1024 * 1024 } }));
  vi.stubGlobal("fetch", fetchMock);
  const file = new File([new Uint8Array(9 * 1024 * 1024)], "lesson.mp4", { type: "video/mp4" });
  const progress = vi.fn();
  const pending = uploadLessonVideo("lesson", file, "private-test-token", progress);
  await vi.runAllTimersAsync(); await pending;
  expect(received).toBe(file.size);
  expect(Math.max(...sizes)).toBe(4 * 1024 * 1024);
  expect(offsets[1]).toBe(4 * 1024 * 1024);
  expect(progress).toHaveBeenLastCalledWith(100);
});
it("rejects an oversized file without a network request", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(uploadLessonVideo("lesson", { size: 2 * 1024 ** 3 + 1 } as File, "token", () => {})).rejects.toThrow("2 ГБ");
  expect(fetchMock).not.toHaveBeenCalled();
});
