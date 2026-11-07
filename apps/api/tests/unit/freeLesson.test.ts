import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
vi.mock("../../src/course/access.js", () => ({ clientIp: (req: express.Request) => req.ip }));
const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  lesson: {
    id: "sample",
    title: "Эклеры",
    recipeText: "Рецепт",
    durationSec: 60,
    encryptionKey: Buffer.alloc(16).toString("base64"),
    coverPath: null,
    posterPath: null,
  },
  create: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  getSetting: (key: string) => Promise.resolve(state.settings.get(key) ?? null),
  prisma: { lesson: { findFirst: vi.fn(async () => state.lesson) }, freeLessonLead: { create: state.create } },
}));
vi.mock("../../src/env.js", () => ({ env: { jwtSecret: "local-free-test", publicBaseUrl: "http://localhost" } }));
vi.mock("../../src/storage/s3.js", () => ({ storageConfig: async () => null, presignGet: vi.fn() }));
vi.mock("../../src/course/manifest.js", () => ({
  masterManifest: async () => "#EXTM3U",
  variantManifest: async () => "#EXTM3U",
}));
import { freeLessonRouter, FREE_BASE, validFreeGrant } from "../../src/site/freeLesson.js";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(freeLessonRouter);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}${FREE_BASE}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  state.settings.clear();
  state.create.mockResolvedValue({ id: "lead" });
});
function token(id = "sample", expiresIn = 60) {
  return jwt.sign({ kind: "free-lesson", lessonId: id }, "local-free-test", {
    audience: "free-lesson",
    subject: "lead",
    expiresIn,
  });
}
const protectedPaths = ["/content", "/lessons/sample/manifest", "/lessons/sample/variant/480p", "/lessons/sample/key"];
describe("free lesson access boundary", () => {
  it("defaults off and writes no leads", async () => {
    expect(await (await fetch(base)).json()).toEqual({ enabled: false });
    const res = await fetch(base + "/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test", phone: "992000000000", lang: "ru" }),
    });
    expect(res.status).toBe(404);
    expect(state.create).not.toHaveBeenCalled();
  });
  it.each(protectedPaths)("denies %s before signup and immediately after switch off", async (path) => {
    state.settings.set("freeLessonEnabled", "true");
    state.settings.set("freeLessonId", "sample");
    expect((await fetch(base + path)).status).toBe(403);
    const headers = { cookie: `ssb_free_lesson=${token()}` };
    expect((await fetch(base + path, { headers })).status).toBe(200);
    state.settings.set("freeLessonEnabled", "false");
    expect((await fetch(base + path, { headers })).status).toBe(403);
  });
  it("issues only a dedicated HttpOnly grant after valid name and phone", async () => {
    state.settings.set("freeLessonEnabled", "true");
    state.settings.set("freeLessonId", "sample");
    const response = await fetch(base + "/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " Test ", phone: "+992 (000) 000-000", lang: "tg" }),
    });
    expect(response.status).toBe(200);
    expect(state.create).toHaveBeenCalledWith({
      data: { name: "Test", phone: "992000000000", lang: "tg", lessonId: "sample" },
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("ssb_course=");
    expect((await fetch(base + "/lessons/paid/key", { headers: { cookie } })).status).toBe(403);
  });
  it("rejects expired, forged, different lesson and paid-session tokens", () => {
    expect(validFreeGrant(token(), "sample")).toBe(true);
    expect(validFreeGrant(token(), "paid")).toBe(false);
    expect(validFreeGrant(token("sample", -1), "sample")).toBe(false);
    expect(validFreeGrant("forged", "sample")).toBe(false);
    expect(validFreeGrant(jwt.sign({ kind: "course-session", lessonId: "sample" }, "local-free-test"), "sample")).toBe(
      false,
    );
  });
});
