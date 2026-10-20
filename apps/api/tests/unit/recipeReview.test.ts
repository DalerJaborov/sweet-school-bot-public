import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => ({ bucket: "b" })),
  presignGet: vi.fn((_cfg: unknown, key: string) => `https://cdn.test/${key}`),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  deleteObject: vi.fn(),
  checkStorageReachable: vi.fn(),
  listBuckets: vi.fn(),
}));

import { courseAdminRouter } from "../../src/course/adminRoutes.js";

/**
 * ПРОВЕРКА OCR-РЕЦЕПТОВ («Утро Ширин» §13): счётчик непроверенных, чтение
 * структурированного рецепта с фото карточки и «Проверила ✓», которое
 * пересобирает markdown из структуры и ставит отметку.
 */

let server: Server;
let base = "";

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

const card = {
  title: "Творожный пирог",
  language: "tg",
  components: [
    { name: "Хамир", items: [{ ingredient: "Орд", amount: "250", unit: "г", note: null, emoji: "🌾" }] },
    { name: "Крем", items: [{ ingredient: "Тухм", amount: "2", unit: "дона", note: "калон", emoji: "🥚" }] },
  ],
};

const lesson = {
  id: "l1",
  title: "Творожный пирог",
  order: 3,
  recipeSource: "card-ocr",
  recipeReviewedAt: null,
  recipeText: "старый текст",
  recipeData: JSON.stringify(card),
  recipePhotos: JSON.stringify(["photos/l1/a.jpg", "photos/l1/b.jpg"]),
  coverPath: null,
  posterPath: null,
  module: { title: "Уроки", course: { title: "21 рецепт" } },
};

describe("проверка рецептов с карточек", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("lesson").count.mockResolvedValue(2);
  });
  afterEach(restorePrisma);

  it("review-count — только распознанные и не проверенные", async () => {
    const body = (await (await fetch(`${base}/admin/recipes/review-count`)).json()) as { count: number };
    expect(body.count).toBe(2);
    expect(db.model("lesson").count).toHaveBeenCalledWith({ where: { recipeSource: "card-ocr", recipeReviewedAt: null, deletedAt: null } });
  });

  it("GET — структура из recipeData, фото карточки подписаны, бейдж «не проверено»", async () => {
    db.model("lesson").findUnique.mockResolvedValue(lesson);
    const res = await fetch(`${base}/admin/lessons/l1/recipe`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recipeData: typeof card; photos: string[]; needsReview: boolean; course: string };
    expect(body.recipeData).toEqual(card);
    expect(body.photos).toEqual(["https://cdn.test/photos/l1/a.jpg", "https://cdn.test/photos/l1/b.jpg"]);
    expect(body.needsReview).toBe(true);
    expect(body.course).toBe("21 рецепт");
  });

  it("GET — урока нет: 404", async () => {
    db.model("lesson").findUnique.mockResolvedValue(null);
    expect((await fetch(`${base}/admin/lessons/nope/recipe`)).status).toBe(404);
  });

  it("PUT «Проверила ✓» — сохраняет структуру, пересобирает markdown и ставит отметку", async () => {
    db.model("lesson").findUnique.mockResolvedValue(lesson);
    db.model("lesson").count.mockResolvedValue(1);
    const edited = {
      ...card,
      components: [
        { name: "Хамир", items: [{ ingredient: "Орд", amount: "260", unit: "г", note: "", emoji: "🌾" }] },
        { name: "Пустой", items: [] },
      ],
    };
    const res = await fetch(`${base}/admin/lessons/l1/recipe`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipeData: edited }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recipeText: string; reviewLeft: number };
    expect(body.ok).toBe(true);
    expect(body.recipeText).toBe("**Хамир**\n- Орд — 260 г");
    expect(body.reviewLeft).toBe(1);

    const update = db.model("lesson").update.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(update.where).toEqual({ id: "l1" });
    expect(update.data.recipeText).toBe("**Хамир**\n- Орд — 260 г");
    expect(update.data.recipeReviewedAt).toBeInstanceOf(Date);
    // Пустая строка примечания → null, пустой компонент выброшен.
    expect(JSON.parse(update.data.recipeData as string)).toEqual({
      title: "Творожный пирог",
      language: "tg",
      components: [{ name: "Хамир", items: [{ ingredient: "Орд", amount: "260", unit: "г", note: null, emoji: "🌾" }] }],
    });
  });

  it("PUT без единого ингредиента — 400, ничего не записано", async () => {
    db.model("lesson").findUnique.mockResolvedValue(lesson);
    const res = await fetch(`${base}/admin/lessons/l1/recipe`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipeData: { components: [{ name: "x", items: [] }] } }),
    });
    expect(res.status).toBe(400);
    expect(db.model("lesson").update).not.toHaveBeenCalled();
  });

  it("список уроков — бейдж needsRecipeReview и обложка в /admin/courses", async () => {
    db.model("course").findMany.mockResolvedValue([
      {
        id: "c1", code: "COURSE70", title: "21 рецепт", description: null, price: 70, active: true, deviceLimit: 2, toolsData: "[]",
        _count: { purchases: 3 },
        modules: [{ id: "m1", title: "Уроки", order: 1, lessons: [
          { ...lesson, hlsPath: null, status: "READY", durationSec: 600, transcript: null, transcriptStatus: "PENDING", isPreview: false, coverPath: "covers/l1.jpg" },
          { ...lesson, id: "l2", recipeReviewedAt: new Date(), hlsPath: null, status: "READY", durationSec: null, transcript: null, transcriptStatus: "PENDING", isPreview: false, posterPath: "posters/l2.jpg" },
        ] }],
      },
    ]);
    const body = (await (await fetch(`${base}/admin/courses`)).json()) as {
      courses: { modules: { lessons: { id: string; needsRecipeReview: boolean; coverUrl: string | null }[] }[] }[];
    };
    const [a, b] = body.courses[0].modules[0].lessons;
    expect(a).toMatchObject({ id: "l1", needsRecipeReview: true, coverUrl: "https://cdn.test/covers/l1.jpg" });
    expect(b).toMatchObject({ id: "l2", needsRecipeReview: false, coverUrl: "https://cdn.test/posters/l2.jpg" });
  });
});
