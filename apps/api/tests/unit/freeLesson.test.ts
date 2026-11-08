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
    recipePhotos: '["recipes/sample.png"]',
    durationSec: 60,
    encryptionKey: Buffer.alloc(16).toString("base64"),
    coverPath: null,
    posterPath: null,
  },
  create: vi.fn(),
  siblings: [
    {
      id: "paid-1", title: "Рафаэлло", order: 2, coverPath: "covers/paid-1.jpg", posterPath: null,
      hlsPath: "courses/c/paid-1/master.m3u8", encryptionKey: "SECRETKEY", recipeText: "Мука 250 г", recipePhotos: "[\"recipes/x.png\"]",
      recipeData: JSON.stringify({ title: "Рафаэлло", language: "ru", components: [{ name: "Крем", items: [
        { ingredient: "Сливки 33%", amount: "250", unit: "мл", note: null, emoji: null },
        { ingredient: "Кокосовая стружка 120 г", amount: null, unit: null, note: null, emoji: null },
        { ingredient: "Сливки 33%", amount: "100", unit: "мл", note: null, emoji: null },
      ] }] }),
    },
  ],
}));
vi.mock("../../src/db.js", () => ({
  getSetting: (key: string) => Promise.resolve(state.settings.get(key) ?? null),
  prisma: { lesson: { findFirst: vi.fn(async () => state.lesson), findMany: vi.fn(async () => state.siblings.map(({ id, title, order, coverPath, posterPath, recipeData }) => ({ id, title, order, coverPath, posterPath, recipeData }))) }, module: { findUnique: vi.fn(async () => ({ courseId: "course-1" })) }, freeLessonLead: { create: state.create } },
}));
vi.mock("../../src/env.js", () => ({ env: { jwtSecret: "local-free-test", publicBaseUrl: "http://localhost" } }));
vi.mock("../../src/storage/s3.js", () => ({ storageConfig: async () => ({}), presignGet: vi.fn(), getObject: async () => Buffer.from("local image fixture") }));
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
const protectedPaths = ["/content", "/lessons/sample/manifest", "/lessons/sample/variant/480p", "/lessons/sample/key", "/lessons/sample/photo/0"];
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

describe("closed showcase (more lessons of the same course)", () => {
  const on = () => {
    state.settings.set("freeLessonEnabled", "true");
    state.settings.set("freeLessonId", "sample");
  };
  it("returns nothing while the free lesson is off", async () => {
    const res = await fetch(base + "/more", { headers: { cookie: `ssb_free_lesson=${token()}` } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Рафаэлло");
  });
  it("without the free-lesson cookie answers 401", async () => {
    on();
    expect((await fetch(base + "/more")).status).toBe(401);
    expect((await fetch(base + "/more/paid-1/cover")).status).toBe(401);
    expect((await fetch(base + "/more", { headers: { cookie: "ssb_free_lesson=forged" } })).status).toBe(401);
  });
  it("gives only order, title, cover and ingredients without amounts — no video, key or grams", async () => {
    on();
    const res = await fetch(base + "/more", { headers: { cookie: `ssb_free_lesson=${token()}` } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      lessons: [
        { id: "paid-1", title: "Рафаэлло", order: 1, coverUrl: `${FREE_BASE}/more/paid-1/cover`, ingredients: ["Сливки 33%", "Кокосовая стружка"] },
      ],
    });
    for (const leak of ["SECRETKEY", "m3u8", "hlsPath", "encryptionKey", "recipeText", "recipePhotos", "250", "120", "100", "amount", "unit"]) {
      expect(body).not.toContain(leak);
    }
  });
  it("serves a cover only for a lesson of the showcase, never an arbitrary id", async () => {
    on();
    const headers = { cookie: `ssb_free_lesson=${token()}` };
    expect((await fetch(base + "/more/paid-1/cover", { headers })).status).toBe(200);
    expect((await fetch(base + "/more/other/cover", { headers })).status).toBe(404);
  });
});
