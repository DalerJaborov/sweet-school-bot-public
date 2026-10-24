// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/course-sw.js", import.meta.url), "utf8");

async function offlineRequest(offlineUntil: string | null | undefined, path = "/offline/key/l1", lessons = ["l1"], legacy = false) {
  const handlers: Record<string, (event: any) => void> = {};
  const course = { modules: [{ lessons: lessons.map((id) => ({ id, ready: true })) }] };
  const saved = offlineUntil === undefined ? undefined : { view: { offlineUntil, ...(legacy ? { course } : { courses: [course] }) } };
  const context = {
    self: { location: { origin: "https://school.example" }, addEventListener: (name: string, fn: any) => { handlers[name] = fn; } },
    URL, Response, Date,
    indexedDB: { open: () => {
      const open: any = {};
      queueMicrotask(() => {
        open.result = {
          close() {},
          transaction: (store: string) => ({ objectStore: () => ({ get: () => {
            const request: any = {};
            queueMicrotask(() => { request.result = store === "meta" ? saved : new Uint8Array([1, 2, 3]).buffer; request.onsuccess(); });
            return request;
          } }) }),
        };
        open.onsuccess();
      });
      return open;
    } },
  };
  runInNewContext(source, context);
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: new Request(`https://school.example${path}`), respondWith: (r: Promise<Response>) => { response = r; } });
  return await response!;
}

describe("saved lesson authorization", () => {
  it.each([undefined, null, "invalid", "2020-01-01T00:00:00Z"])("does not serve saved encryption keys without valid offline access (%s)", async (until) => {
    expect((await offlineRequest(until)).status).toBe(403);
  });
  it("keeps paid students' authorized offline lessons available", async () => {
    const response = await offlineRequest(new Date(Date.now() + 86400_000).toISOString());
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  });
  it.each(["/offline/key/l1", "/offline/manifest/l1", "/offline/seg/l1/0.ts", "/offline/photo/l1/0", "/offline/poster/l1"])("revoking one course also denies its saved material while another course remains paid (%s)", async (path) => {
    const response = await offlineRequest(new Date(Date.now() + 86400_000).toISOString(), path, ["other-lesson"]);
    expect(response.status).toBe(403);
  });
  it("supports an authorized student with the legacy single-course cache", async () => {
    expect((await offlineRequest(new Date(Date.now() + 86400_000).toISOString(), "/offline/manifest/l1", ["l1"], true)).status).toBe(200);
  });
  it.each(["/offline/manifest/l1", "/offline/seg/l1/0.ts", "/offline/photo/l1/0", "/offline/poster/l1"])("keeps authorized offline material readable (%s)", async (path) => {
    expect((await offlineRequest(new Date(Date.now() + 86400_000).toISOString(), path)).status).toBe(200);
  });
  it.each(["/offline/unknown/l1", "/offline/key/l1/extra", "/offline/photo/l1/no-index"])("denies malformed offline paths (%s)", async (path) => {
    expect((await offlineRequest(new Date(Date.now() + 86400_000).toISOString(), path)).status).toBe(403);
  });
});
