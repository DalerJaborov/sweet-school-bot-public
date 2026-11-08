import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import express from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { signAdminToken } from "../../src/adminLogin.js";
import { adminRouter } from "../../src/admin.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * Кнопка «Посмотреть как ученица» в панели: билет выдаётся ТОЛЬКО за паролем
 * панели и ничего не создаёт в боевых данных.
 */

let server: Server;
let base: string;
let db: PrismaMock;
const token = signAdminToken();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  db = mockPrisma();
  db.model("course").findMany.mockResolvedValue([{ id: "course-1" }, { id: "course-2" }]);
});
afterEach(restorePrisma);

const post = (body: unknown, auth: string | null = token) =>
  fetch(`${base}/admin/course-preview`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /admin/course-preview", () => {
  it("без входа в панель — 401, билета нет", async () => {
    const res = await post({}, null);
    expect(res.status).toBe(401);
    expect(db.model("course").findMany).not.toHaveBeenCalled();
  });

  it("токен ученицы панель не открывает", async () => {
    const student = jwt.sign({ kind: "course-session", contactId: "c1", deviceId: "d1" }, courseTokenSecret(), {
      expiresIn: "1d",
    });
    expect((await post({}, student)).status).toBe(401);
  });

  it("владелец получает адрес приложения ученицы с одноразовым билетом", async () => {
    const res = await post({ courseId: "course-1" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/course\?preview=[\w.%-]+$/);
    expect(db.model("course").findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "course-1" } }));
    // Ничего не создано: ни покупки, ни устройства, ни контакта.
    for (const model of ["purchase", "device", "contact", "progress"]) {
      expect(db.model(model).create).not.toHaveBeenCalled();
      expect(db.model(model).update).not.toHaveBeenCalled();
      expect(db.model(model).upsert).not.toHaveBeenCalled();
    }
  });

  it("неизвестный курс — 404", async () => {
    db.model("course").findMany.mockResolvedValue([]);
    expect((await post({ courseId: "nope" })).status).toBe(404);
  });
});
