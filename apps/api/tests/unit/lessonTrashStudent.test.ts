import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * КОРЗИНА УРОКОВ и УЧЕНИЦА: удалённый урок не попадает ни в /me, ни в
 * манифест/ключ по прямой ссылке — даже пока он ещё лежит в корзине и его
 * можно вернуть. Доступ ученицы — за моком: тест про фильтр, а не про сессии.
 */

const contact = fakeContact({ id: "ct-1" });
const purchase = { id: "p1", contactId: "ct-1", courseId: "c1", course: "COURSE70", createdAt: new Date() };
const device = { id: "d1", contactId: "ct-1", blockedAt: null, offlineKeyExpiresAt: null };

vi.mock("../../src/course/access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/course/access.js")>();
  return {
    ...actual,
    currentAccess: vi.fn(async () => ({ ok: true, contact, purchases: [purchase], purchase, device })),
  };
});
vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => null),
  presignGet: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

import { courseRouter } from "../../src/course/router.js";

let server: Server;
let base = "";
let db: PrismaMock;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(courseRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockResolvedValue(null);
});
afterEach(restorePrisma);

describe("ученица и корзина", () => {
  it("GET /api/course/me — уроки запрашиваются только живыми", async () => {
    db.model("course").findMany.mockResolvedValue([]);
    const res = await fetch(`${base}/api/course/me`);
    expect(res.status).toBe(200);
    const arg = db.model("course").findMany.mock.calls[0][0] as {
      include: { modules: { include: { lessons: { where: unknown } } } };
    };
    expect(arg.include.modules.include.lessons.where).toEqual({ deletedAt: null });
  });

  it("манифест урока из корзины — 404, даже по прямой ссылке", async () => {
    db.model("lesson").findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/api/course/lessons/l-trashed/manifest`);
    expect(res.status).toBe(404);
    expect(db.model("lesson").findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "l-trashed", deletedAt: null } });
    expect(db.model("lesson").findUnique).not.toHaveBeenCalled();
  });
});
