import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const storage = {
  storageConfig: vi.fn(async (): Promise<unknown> => ({ bucket: "b" })),
  getObject: vi.fn(async (): Promise<Buffer | null> => null),
  deleteObject: vi.fn(async () => undefined),
};
vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: (...a: unknown[]) => storage.storageConfig(...(a as [])),
  getObject: (...a: unknown[]) => storage.getObject(...(a as [])),
  deleteObject: (...a: unknown[]) => storage.deleteObject(...(a as [])),
  presignGet: vi.fn((_cfg: unknown, key: string) => `https://cdn.test/${key}`),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

import { courseAdminRouter } from "../../src/course/adminRoutes.js";
import { purgeTrashedLessons, restoreLesson, listTrash, TRASH_TTL_MS } from "../../src/course/lessonTrash.js";
import { coursePlatformReady } from "../../src/course/delivery.js";
import { courseCompleted } from "../../src/course/certificate.js";

/**
 * КОРЗИНА УРОКОВ («Утро Ширин» §19): удаление мягкое, 24 часа на возврат,
 * потом чистка строки и файлов. Удалённый урок не виден нигде — ни ученице,
 * ни каталогу, ни сертификату.
 */

let server: Server;
let base = "";
let db: PrismaMock;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(courseAdminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  db = mockPrisma();
  storage.storageConfig.mockResolvedValue({ bucket: "b" });
  storage.getObject.mockResolvedValue(null);
  storage.deleteObject.mockResolvedValue(undefined);
});
afterEach(() => {
  restorePrisma();
  vi.useRealTimers();
});

describe("DELETE /admin/lessons/:id — мягкое удаление", () => {
  it("ставит deletedAt и возвращает срок возврата через 24 ч", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
    db.model("lesson").findFirst.mockResolvedValue({ id: "l1" });
    const res = await fetch(`${base}/admin/lessons/l1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { undoUntil: string };
    expect(body.undoUntil).toBe("2026-09-06T10:00:00.000Z");
    expect(db.model("lesson").update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: { deletedAt: new Date("2026-09-05T10:00:00Z") },
    });
    expect(db.model("lesson").delete).not.toHaveBeenCalled();
  });

  it("уже удалённый или несуществующий — 404, второй раз не трогаем", async () => {
    db.model("lesson").findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/admin/lessons/l1`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(db.model("lesson").update).not.toHaveBeenCalled();
  });
});

describe("POST /admin/lessons/:id/restore", () => {
  it("возвращает урок на прежний номер, если место свободно", async () => {
    db.model("lesson").findFirst
      .mockResolvedValueOnce({ id: "l1", moduleId: "m1", order: 3 })
      .mockResolvedValueOnce(null);
    const res = await fetch(`${base}/admin/lessons/l1/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, order: 3 });
    expect(db.model("lesson").update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { deletedAt: null, order: 3 } });
  });

  it("место занято новым уроком — встаёт в конец раздела", async () => {
    db.model("lesson").findFirst
      .mockResolvedValueOnce({ id: "l1", moduleId: "m1", order: 3 })
      .mockResolvedValueOnce({ id: "l9" })
      .mockResolvedValueOnce({ order: 7 });
    const r = await restoreLesson("l1");
    expect(r).toEqual({ order: 8 });
  });

  it("урока нет в корзине — 404", async () => {
    db.model("lesson").findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/admin/lessons/l1/restore`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/lessons/trash", () => {
  it("отдаёт удалённые с датой чистки, уже просроченные не показывает", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    db.model("lesson").findMany.mockResolvedValue([
      { id: "l1", title: "Эклеры", order: 2, deletedAt: new Date("2026-09-05T10:00:00Z"), module: { title: "Уроки", course: { title: "21 рецепт" } } },
      { id: "l0", title: "Старый", order: 1, deletedAt: new Date("2026-09-03T10:00:00Z"), module: { title: "Уроки", course: { title: "21 рецепт" } } },
    ]);
    const res = await fetch(`${base}/admin/lessons/trash`);
    const body = (await res.json()) as { rows: { id: string; purgeAt: string; course: string }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: "l1", course: "21 рецепт", purgeAt: "2026-09-06T10:00:00.000Z" });
    expect(db.model("lesson").findMany.mock.calls[0][0]).toMatchObject({ where: { deletedAt: { not: null } } });
  });

  it("listTrash — пустая корзина", async () => {
    db.model("lesson").findMany.mockResolvedValue([]);
    expect(await listTrash()).toEqual([]);
  });
});

describe("purgeTrashedLessons — чистка через 24 часа", () => {
  const trashed = {
    id: "l1",
    hlsPath: "courses/m1/l1/master.m3u8",
    sourcePath: "sources/l1.mp4",
    posterPath: "courses/m1/l1/poster.jpg",
    coverPath: null,
    storyPath: null,
    teaserPath: null,
    teaserMp4Path: "courses/m1/l1/teaser.mp4",
    recipePhotos: JSON.stringify(["photos/l1/a.jpg"]),
    attachments: JSON.stringify([{ title: "PDF", path: "files/l1/recipe.pdf" }]),
  };

  it("удаляет файлы (HLS по плейлистам) и только потом строку", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T11:00:00Z"));
    db.model("lesson").findMany.mockResolvedValue([trashed]);
    storage.getObject.mockImplementation(async (_cfg: unknown, key: string) => {
      if (key === "courses/m1/l1/master.m3u8") return Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/index.m3u8\n480p/index.m3u8\n");
      if (key.endsWith("/index.m3u8")) return Buffer.from("#EXTM3U\n#EXTINF:6,\nseg_000.ts\n#EXTINF:6,\nseg_001.ts\n");
      return null;
    });
    const order: string[] = [];
    storage.deleteObject.mockImplementation(async (_cfg: unknown, key: string) => {
      order.push(`del:${key}`);
    });
    db.model("lesson").delete.mockImplementation(async () => {
      order.push("row");
      return undefined;
    });

    const r = await purgeTrashedLessons();
    expect(r).toEqual({ purged: 1, failed: 0 });
    const where = db.model("lesson").findMany.mock.calls[0][0] as { where: { deletedAt: { lte: Date } } };
    expect(where.where.deletedAt.lte).toEqual(new Date(Date.now() - TRASH_TTL_MS));
    const deleted = order.filter((x) => x.startsWith("del:")).map((x) => x.slice(4));
    expect(deleted).toEqual(
      expect.arrayContaining([
        "sources/l1.mp4",
        "courses/m1/l1/poster.jpg",
        "courses/m1/l1/teaser.mp4",
        "photos/l1/a.jpg",
        "files/l1/recipe.pdf",
        "courses/m1/l1/master.m3u8",
        "courses/m1/l1/720p/index.m3u8",
        "courses/m1/l1/720p/seg_000.ts",
        "courses/m1/l1/720p/seg_001.ts",
        "courses/m1/l1/480p/index.m3u8",
        "courses/m1/l1/480p/seg_001.ts",
      ])
    );
    expect(order[order.length - 1]).toBe("row");
    expect(db.model("lesson").delete).toHaveBeenCalledWith({ where: { id: "l1" } });
  });

  it("хранилище отказало — строка остаётся, следующий час попробуем снова", async () => {
    db.model("lesson").findMany.mockResolvedValue([trashed]);
    storage.deleteObject.mockRejectedValue(new Error("R2 down"));
    expect(await purgeTrashedLessons()).toEqual({ purged: 0, failed: 1 });
    expect(db.model("lesson").delete).not.toHaveBeenCalled();
  });

  it("хранилище не настроено — строку всё равно чистим", async () => {
    storage.storageConfig.mockResolvedValue(null);
    db.model("lesson").findMany.mockResolvedValue([{ ...trashed, hlsPath: null }]);
    expect(await purgeTrashedLessons()).toEqual({ purged: 1, failed: 0 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(db.model("lesson").delete).toHaveBeenCalledTimes(1);
  });

  it("корзина пуста — в хранилище не ходим", async () => {
    db.model("lesson").findMany.mockResolvedValue([]);
    expect(await purgeTrashedLessons()).toEqual({ purged: 0, failed: 0 });
    expect(storage.storageConfig).not.toHaveBeenCalled();
  });
});

describe("удалённые уроки не считаются нигде", () => {
  it("GET /admin/courses — уроки только живые", async () => {
    db.model("course").findMany.mockResolvedValue([]);
    await fetch(`${base}/admin/courses`);
    const arg = db.model("course").findMany.mock.calls[0][0] as { include: { modules: { include: { lessons: { where: unknown } } } } };
    expect(arg.include.modules.include.lessons.where).toEqual({ deletedAt: null });
  });

  it("coursePlatformReady считает только живые уроки", async () => {
    db.model("course").findUnique.mockResolvedValue({ id: "c1", code: "COURSE70" });
    db.model("course").findFirst.mockResolvedValue({ id: "c1", code: "COURSE70" });
    db.model("lesson").count.mockResolvedValue(0);
    expect(await coursePlatformReady("COURSE70")).toBe(false);
    const where = db.model("lesson").count.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(where.where).toMatchObject({ deletedAt: null });
  });

  it("сертификат: урок в корзине не блокирует и не засчитывается", async () => {
    db.model("lesson").findMany.mockResolvedValue([{ id: "a" }]);
    db.model("progress").count.mockResolvedValue(1);
    expect(await courseCompleted("p1", "c1")).toEqual({ done: 1, total: 1 });
    const where = db.model("lesson").findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(where.where).toMatchObject({ status: "READY", deletedAt: null });
  });
});
