import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Живой случай 05.09.2026 (@lazina_0101): скачивание фото оборвалось по
 * таймауту (CDN Instagram отдал файл медленно), картинка потерялась молча.
 * Один быстрый повтор почти всегда решает именно эту причину.
 */
describe("fetchAttachment — один быстрый повтор перед тем, как сдаться", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("первая попытка оборвалась, вторая удалась — вложение не теряется", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("aborted"))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "image/jpeg"]]),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { fetchAttachment } = await import("../../src/ai/media.js");
    const result = await fetchAttachment("https://example.com/photo.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("image/jpeg");
  });

  it("обе попытки оборвались — вернёт null, а не бросит исключение", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("aborted"));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchAttachment } = await import("../../src/ai/media.js");
    const result = await fetchAttachment("https://example.com/photo.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });
});
