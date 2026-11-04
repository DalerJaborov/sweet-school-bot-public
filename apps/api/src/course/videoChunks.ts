import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";

export const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TTL = 24 * 3600_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const input = z.object({ size: z.number().int().positive().max(VIDEO_MAX_BYTES), mime: z.enum(["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"]) });
type Meta = { id: string; lessonId: string; size: number; mime: string; expires: number; state: "uploading" | "processing" | "done" | "failed" };
export type CompletedVideo = { id: string; lessonId: string; file: string; mime: string };
type Deps = { dir: string; check: (lessonId: string) => Promise<void>; accept: (video: CompletedVideo) => Promise<void>; log?: (error: unknown) => void };
class UploadFailure extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Mounted below admin authentication. UUID paths, bounded reservations and offset checks
 * prevent traversal, unlimited temporary disk use and duplicate chunks after a lost response.
 * One API process owns this volume; do not share it between concurrent API replicas. */
export function createVideoChunkRouter(deps: Deps): Router {
  const router = Router();
  const busy = new Set<string>();
  const jobs = new Set<string>();
  const file = (id: string, suffix: string) => path.join(deps.dir, `${id}.${suffix}`);
  const write = async (meta: Meta) => {
    await fs.writeFile(file(meta.id, "json.tmp"), JSON.stringify(meta), { mode: 0o600 });
    // Windows can briefly deny replacement while a status request reads the receipt.
    // Keep the atomic rename; never delete the previous valid receipt to work around it.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(file(meta.id, "json.tmp"), file(meta.id, "json")); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  };
  async function locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (busy.has(id)) throw new UploadFailure(409, "Загрузка занята, повторите запрос");
    busy.add(id);
    try { return await run(); } finally { busy.delete(id); }
  }
  async function read(id: string, lessonId: string): Promise<Meta> {
    if (!ID.test(id)) throw new UploadFailure(404, "Загрузка не найдена");
    let meta: Meta;
    try { meta = JSON.parse(await fs.readFile(file(id, "json"), "utf8")) as Meta; }
    catch { throw new UploadFailure(404, "Загрузка не найдена"); }
    if (meta.id !== id || meta.lessonId !== lessonId) throw new UploadFailure(404, "Загрузка не найдена");
    if (meta.expires < Date.now() && !jobs.has(id)) throw new UploadFailure(410, "Время загрузки истекло, выберите файл заново");
    return meta;
  }
  async function received(meta: Meta): Promise<number> {
    if (meta.state === "done") return meta.size;
    return (await fs.stat(file(meta.id, "part"))).size;
  }
  const dto = async (meta: Meta) => ({ uploadId: meta.id, size: meta.size, received: await received(meta), chunkBytes: VIDEO_CHUNK_BYTES, state: meta.state });
  const handler = (run: RequestHandler): RequestHandler => (req, res, next) => {
    Promise.resolve(run(req, res, next)).catch((error: unknown) => {
      if (!(error instanceof UploadFailure)) deps.log?.(error);
      if (!res.headersSent) res.status(error instanceof UploadFailure ? error.status : 500).json({ error: error instanceof UploadFailure ? error.message : "Не удалось обработать загрузку. Попробуйте ещё раз" });
    });
  };
  async function cleanAndReserve(size: number) {
    await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 });
    let count = 0, reserved = 0, remaining = 0;
    for (const name of await fs.readdir(deps.dir)) {
      if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
      const meta = JSON.parse(await fs.readFile(path.join(deps.dir, name), "utf8")) as Meta;
      if (meta.expires < Date.now() && !busy.has(meta.id) && !jobs.has(meta.id)) {
        await fs.rm(file(meta.id, "part"), { force: true });
        await fs.rm(file(meta.id, "json"), { force: true });
      } else if (meta.state !== "done") {
        count++; reserved += meta.size;
        remaining += Math.max(0, meta.size - (await fs.stat(file(meta.id, "part"))).size);
      }
    }
    if (count >= 4 || reserved + size > 8 * VIDEO_MAX_BYTES) throw new UploadFailure(429, "Слишком много незавершённых загрузок. Завершите или отмените предыдущую");
    const disk = await fs.statfs(deps.dir);
    if (disk.bavail * disk.bsize < remaining + size + VIDEO_MAX_BYTES) throw new UploadFailure(507, "На сервере недостаточно свободного места");
  }
  const base = "/admin/lessons/:id/video-uploads";
  router.post(base, handler(async (req, res) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) throw new UploadFailure(400, "Нужен видеофайл MP4, MOV, MKV или WebM размером до 2 ГБ");
    await deps.check(req.params.id);
    const meta = await locked("create", async () => {
      await cleanAndReserve(parsed.data.size);
      const meta: Meta = { id: crypto.randomUUID(), lessonId: req.params.id, ...parsed.data, expires: Date.now() + TTL, state: "uploading" };
      await fs.writeFile(file(meta.id, "part"), "", { flag: "wx", mode: 0o600 });
      try { await write(meta); } catch (error) { await fs.rm(file(meta.id, "part"), { force: true }); throw error; }
      return meta;
    });
    res.status(201).json(await dto(meta));
  }));
  router.get(`${base}/:uid`, handler(async (req, res) => { res.json(await dto(await read(req.params.uid, req.params.id))); }));
  router.patch(`${base}/:uid`, express.raw({ type: "application/octet-stream", limit: VIDEO_CHUNK_BYTES }), handler(async (req, res) => {
    const offset = Number(req.header("upload-offset"));
    if (!req.header("upload-offset") || !Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(req.body) || !req.body.length) throw new UploadFailure(400, "Нужны данные части и смещение Upload-Offset");
    await locked(req.params.uid, async () => {
      const meta = await read(req.params.uid, req.params.id);
      const have = await received(meta);
      if (meta.state !== "uploading" || have !== offset) { res.status(409).json({ error: "Смещение изменилось", received: have }); return; }
      if (have + req.body.length > meta.size) throw new UploadFailure(413, "Размер файла превышен");
      await fs.appendFile(file(meta.id, "part"), req.body);
      res.json({ received: await received(meta) });
    });
  }));
  router.post(`${base}/:uid/complete`, handler(async (req, res) => {
    await locked(req.params.uid, async () => {
      const meta = await read(req.params.uid, req.params.id);
      if (meta.state === "done") { res.json({ ok: true, state: "done" }); return; }
      if (await received(meta) !== meta.size) throw new UploadFailure(409, "Файл ещё не загружен целиком");
      // S3 upload may outlast a proxy request. The receipt stays on disk; after restart
      // another complete safely retries the same deterministic object/lesson operation.
      if (!jobs.has(meta.id)) {
        meta.state = "processing";
        await write(meta);
        jobs.add(meta.id);
        void (async () => {
          try {
            await deps.check(meta.lessonId);
            await deps.accept({ id: meta.id, lessonId: meta.lessonId, file: file(meta.id, "part"), mime: meta.mime });
            meta.state = "done";
            await write(meta);
            // A cleanup failure must not turn an accepted, durable receipt into failure.
            await fs.rm(file(meta.id, "part"), { force: true }).catch((error: unknown) => deps.log?.(error));
          } catch (error) { deps.log?.(error); meta.state = "failed"; await write(meta); }
          finally { jobs.delete(meta.id); }
        })().catch((error: unknown) => deps.log?.(error));
      }
      res.status(202).json({ state: "processing" });
    });
  }));
  router.delete(`${base}/:uid`, handler(async (req, res) => {
    await locked(req.params.uid, async () => {
      const meta = await read(req.params.uid, req.params.id);
      if (jobs.has(meta.id) || meta.state === "processing") throw new UploadFailure(409, "Файл уже передаётся в хранилище");
      await fs.rm(file(meta.id, "part"), { force: true });
      await fs.rm(file(meta.id, "json"), { force: true });
      res.status(204).end();
    });
  }));
  return router;
}
