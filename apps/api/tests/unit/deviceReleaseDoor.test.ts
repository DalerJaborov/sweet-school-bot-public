import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => null),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
  presignGet: vi.fn(),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

import { courseAdminRouter } from "../../src/course/adminRoutes.js";

/**
 * «ОСВОБОДИТЬ МЕСТО» В ПАНЕЛИ И ОДНА ДВЕРЬ УДАЛЕНИЯ УСТРОЙСТВА (08.11.2026).
 *
 * Место освобождают ученица (замена), бот (самовосстановление) и хозяйка
 * (кнопка в карточке). Все трое идут через access.ts releaseDevice, которая
 * пишет журнал AccessEvent. Прямой prisma.device.delete в другом файле — это
 * удаление без следа; сторож ниже не даёт ему появиться.
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
});
afterEach(restorePrisma);

const device = {
  id: "device-1",
  contactId: "contact-1",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  lastCity: "TJ",
  blockedAt: null,
};

describe("POST /admin/course-devices/:id/release", () => {
  it("освобождение: устройство снимается через releaseDevice и пишется в журнал", async () => {
    db.model("device").findUnique.mockResolvedValue(device);

    const res = await fetch(`${base}/admin/course-devices/device-1/release`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(db.model("device").delete).toHaveBeenCalledWith({ where: { id: "device-1" } });
  });

  it("устройства уже нет — 404 простыми словами, ничего не удаляем", async () => {
    db.model("device").findUnique.mockResolvedValue(null);

    const res = await fetch(`${base}/admin/course-devices/nope/release`, { method: "POST" });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("Устройство не найдено");
    expect(db.model("device").delete).not.toHaveBeenCalled();
  });

  it("ЗАБЛОКИРОВАННОЕ не освобождается: 409 «сначала разблокируйте», блокировка остаётся", async () => {
    db.model("device").findUnique.mockResolvedValue({ ...device, blockedAt: new Date() });

    const res = await fetch(`${base}/admin/course-devices/device-1/release`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("разблокируйте");
    expect(db.model("device").delete).not.toHaveBeenCalled();
    expect(db.model("accessEvent").create).not.toHaveBeenCalled();
  });

  it("дверь сама защищает: releaseDevice отказывает заблокированному для ЛЮБОГО вызывающего", async () => {
    const { releaseDevice, DeviceBlockedError } = await import("../../src/course/access.js");
    await expect(releaseDevice({ ...device, blockedAt: new Date() } as never, "bot")).rejects.toBeInstanceOf(DeviceBlockedError);
    expect(db.model("device").delete).not.toHaveBeenCalled();
  });

  it("блокировка и разблокировка тоже попадают в журнал", async () => {
    db.model("device").update.mockResolvedValue({ ...device, blockedAt: new Date() });

    await fetch(`${base}/admin/course-devices/device-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocked: true }),
    });

    expect(db.model("accessEvent").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "blocked", actor: "owner" }),
    });
  });
});

describe("сторож: устройство удаляется только через releaseDevice", () => {
  it("prisma.device.delete / deleteMany встречается только в course/access.ts", () => {
    const root = path.resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (/\bdevice\s*\.\s*delete(Many)?\s*\(/.test(src) && !full.endsWith(path.join("course", "access.ts"))) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
