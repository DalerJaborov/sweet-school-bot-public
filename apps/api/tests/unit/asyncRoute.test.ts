import { describe, it, expect, vi, afterEach } from "vitest";
import express, { Router, type Router as RouterType } from "express";
import type { Server } from "node:http";
import { autoCatch } from "../../src/asyncRoute.js";

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
vi.mock("../../src/health.js", () => ({ healthReport: vi.fn(), markWorkerTick: vi.fn() }));

import { todayRouter } from "../../src/today.js";
import { textsRouter } from "../../src/textsRoutes.js";
import { courseAdminRouter } from "../../src/course/adminRoutes.js";
import { importRouter } from "../../src/course/importRoutes.js";
import { metricsRouter } from "../../src/metrics.js";
import { searchRouter } from "../../src/search.js";
import { assistantRouter } from "../../src/assistantPanel.js";

/**
 * АДМИНСКИЕ ПОД-РОУТЕРЫ ОБЯЗАНЫ ЛОВИТЬ ОТКЛОНЁННЫЙ ПРОМИС САМИ.
 *
 * index.ts оборачивает adminRouter в autoCatch, но обёртка патчит только
 * router.get/post самого adminRouter. Маршруты, объявленные на вложенном
 * роутере (adminRouter.use(courseAdminRouter)), Express 4 не защищает:
 * упавший prisma-запрос уходил в unhandledRejection, а запрос панели висел
 * навсегда — владелица видела вечный скелетон (финальный аудит 05.09.2026).
 * Тест регистрирует на каждом экспортированном роутере падающий маршрут и
 * ждёт 500 от общего error-middleware, а не тайм-аут.
 */
const ROUTERS: [string, RouterType][] = [
  ["todayRouter", todayRouter],
  ["textsRouter", textsRouter],
  ["courseAdminRouter", courseAdminRouter],
  ["importRouter", importRouter],
  ["metricsRouter", metricsRouter],
  ["searchRouter", searchRouter],
  ["assistantRouter", assistantRouter],
];

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function serve(router: RouterType): Promise<string> {
  const app = express();
  app.use(router);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "поймано" });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address();
  return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
}

async function getWithTimeout(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return res.status;
}

describe("autoCatch", () => {
  it("protects routes registered before autoCatch is called", async () => {
    const router = Router();
    router.get("/existing", async () => { throw new Error("existing rejection"); });
    autoCatch(router);
    expect(await getWithTimeout(`${await serve(router)}/existing`)).toBe(500);
  });

  it("protects already-mounted nested routers and their later routes", async () => {
    const child = Router();
    child.get("/old", async () => { throw new Error("nested old"); });
    const parent = Router(); parent.use("/nested", child); autoCatch(parent);
    child.get("/new", async () => { throw new Error("nested new"); });
    const base = await serve(parent);
    expect(await getWithTimeout(`${base}/nested/old`)).toBe(500);
    expect(await getWithTimeout(`${base}/nested/new`)).toBe(500);
  });

  it("protects future nested routers, middleware and route chaining", async () => {
    const parent = autoCatch(Router());
    const child = Router(); child.get("/boom", async () => { throw new Error("nested"); });
    parent.use("/nested", child);
    parent.use("/middleware", async () => { throw new Error("middleware"); });
    parent.route("/chain").get(async () => { throw new Error("route chain"); });
    const base = await serve(parent);
    for (const path of ["/nested/boom", "/middleware", "/chain"]) expect(await getWithTimeout(base + path)).toBe(500);
  });

  it("preserves error middleware identity, catches sync throws and does not double wrap", async () => {
    const router = Router();
    router.get("/sync", () => { throw new Error("sync"); });
    const errorHandler = (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ caught: true });
    router.use(errorHandler);
    autoCatch(router);
    const stack = router.stack as { handle: unknown; route?: { stack: { handle: unknown }[] } }[];
    const first = stack[0].route!.stack[0].handle;
    autoCatch(router);
    expect(stack[0].route!.stack[0].handle).toBe(first);
    expect(stack[1].handle).toBe(errorHandler);
    expect(await getWithTimeout(`${await serve(router)}/sync`)).toBe(500);
  });

  // Контроль «без обёртки» здесь не держим: голый Router() на Express 4 роняет
  // отклонённый промис в unhandledRejection, и vitest честно считает это
  // ошибкой прогона — что и есть доказательство бага, но в зелёном наборе
  // ему не место.
  it("обёрнутый роутер отдаёт 500 через error-middleware", async () => {
    const wrapped = autoCatch(Router());
    wrapped.get("/boom", async () => {
      throw new Error("db down");
    });
    const base = await serve(wrapped);
    expect(await getWithTimeout(`${base}/boom`)).toBe(500);
  });

  it.each(ROUTERS)("%s экспортируется уже обёрнутым", async (_name, router) => {
    router.get("/__audit/boom", async () => {
      throw new Error("db down");
    });
    const base = await serve(router);
    expect(await getWithTimeout(`${base}/__audit/boom`)).toBe(500);
  });
});
