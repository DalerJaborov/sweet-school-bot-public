import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createVideoChunkRouter, VIDEO_CHUNK_BYTES, VIDEO_MAX_BYTES } from "../../src/course/videoChunks.js";

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function rig(dir?: string, accept = vi.fn(async () => {})) {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), "school-chunks-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const app = express();
  app.use((req, res, next) => req.header("authorization") === "Bearer test-admin" ? next() : void res.sendStatus(401));
  app.use(express.json());
  const errors: unknown[] = [];
  app.use(createVideoChunkRouter({ dir, check: async () => {}, accept, log: (error) => errors.push(error) }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/admin/lessons/lesson1/video-uploads`;
  const req = (suffix = "", method = "GET", body?: unknown, headers = {}) => fetch(base + suffix, { method, headers: { authorization: "Bearer test-admin", "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json", ...headers }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
  const start = async (size = 6) => { const res = await req("", "POST", { size, mime: "video/mp4" }); return { res, data: await res.json() as { uploadId: string } }; };
  return { req, start, dir, accept, base, errors };
}
it("rejects anonymous access and invalid sizes before creating files", async () => {
  const r = await rig();
  expect((await fetch(r.base, { method: "POST" })).status).toBe(401);
  expect((await r.start(VIDEO_MAX_BYTES + 1)).res.status).toBe(400);
  expect((await r.start(0)).res.status).toBe(400);
  expect(await fs.readdir(r.dir)).toEqual([]);
});
it("resumes after a server restart and refuses duplicate/out-of-order chunks", async () => {
  const r = await rig(); const { data } = await r.start(); const suffix = `/${data.uploadId}`;
  expect((await r.req(suffix, "PATCH", Buffer.from("abc"), { "upload-offset": "0" })).status).toBe(200);
  expect((await r.req(suffix, "PATCH", Buffer.from("abc"), { "upload-offset": "0" })).status).toBe(409);
  const restarted = await rig(r.dir);
  expect((await (await restarted.req(suffix)).json()).received).toBe(3);
  expect((await restarted.req(suffix, "PATCH", Buffer.from("def"), { "upload-offset": "3" })).status).toBe(200);
  expect(await fs.readFile(path.join(r.dir, `${data.uploadId}.part`), "utf8")).toBe("abcdef");
});
it("bounds chunks, prevents cross-lesson access, and requires all bytes before completion", async () => {
  const r = await rig(); const { data } = await r.start(); const suffix = `/${data.uploadId}`;
  expect((await r.req(suffix, "PATCH", Buffer.alloc(VIDEO_CHUNK_BYTES + 1), { "upload-offset": "0" })).status).toBe(413);
  expect((await fetch(r.base.replace("lesson1", "lesson2") + suffix, { headers: { authorization: "Bearer test-admin" } })).status).toBe(404);
  expect((await r.req(suffix + "/complete", "POST", {})).status).toBe(409);
  expect(r.accept).not.toHaveBeenCalled();
});
it.each(Array.from({ length: 10 }, (_, i) => i))("completion is idempotent while storage is busy and after receipt/restart (%i)", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const accept = vi.fn(async () => { await wait; });
  const r = await rig(undefined, accept); const { data } = await r.start(3); const suffix = `/${data.uploadId}`;
  await r.req(suffix, "PATCH", Buffer.from("abc"), { "upload-offset": "0" });
  expect((await r.req(suffix + "/complete", "POST", {})).status).toBe(202);
  await r.req(suffix + "/complete", "POST", {});
  expect(accept).toHaveBeenCalledTimes(1);
  expect((await r.req(suffix, "DELETE")).status).toBe(409);
  release();
  await vi.waitFor(async () => { expect((await (await r.req(suffix)).json()).state, String(r.errors)).toBe("done"); });
  const restarted = await rig(r.dir);
  expect((await restarted.req(suffix + "/complete", "POST", {})).status).toBe(200);
  expect(restarted.accept).not.toHaveBeenCalled();
});
it("supports declared 2 GiB files and caps temporary reservations", async () => {
  const r = await rig();
  expect((await r.start(VIDEO_MAX_BYTES)).res.status).toBe(201);
  for (let i = 0; i < 3; i++) expect((await r.start()).res.status).toBe(201);
  expect((await r.start()).res.status).toBe(429);
});
it("transfers a large file using only bounded requests (2 GiB with LARGE_UPLOAD_TEST)", async () => {
  const r = await rig(); const size = process.env.LARGE_UPLOAD_TEST ? VIDEO_MAX_BYTES : 104 * 1024 * 1024;
  const { data } = await r.start(size); const suffix = `/${data.uploadId}`;
  const part = Buffer.alloc(VIDEO_CHUNK_BYTES, 0x61);
  for (let offset = 0; offset < size; offset += part.length) {
    const res = await r.req(suffix, "PATCH", part, { "upload-offset": String(offset) });
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(offset + part.length);
  }
  expect((await fs.stat(path.join(r.dir, `${data.uploadId}.part`))).size).toBe(size);
}, 120_000);
