import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

/**
 * ОБЛОЖКИ УРОКА — тест на подключение, а не на рендер картинки (сам рендер
 * покрыт coverArt.test.ts). Проверяем ровно то, что описано в задании:
 *  - генерируется из кадра тизера, если тизер есть, и не дублируется постером;
 *  - иначе — из постера урока;
 *  - падение renderLessonCover/renderStoryCover не роняет processLesson().
 *
 * ffmpeg подделан на уровне node:child_process: реальный бинарник не нужен
 * (CI/машина разработчика могут быть без него), а «кадр» — это просто файл,
 * который наш фейковый ffmpeg кладёт по тому же пути, что и настоящий,
 * содержимым `fake:<путь>` — этого достаточно, чтобы отличить кадр тизера от
 * кадра постера в assert'ах ниже, не рендеря реальные JPEG.
 */
vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[] = []) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      void (async () => {
        if (cmd === "ffprobe") {
          // Без "nokey=1" ffprobe печатает "key=value" построчно; с ним — голое число.
          const joined = args.join(" ");
          child.stdout.emit("data", Buffer.from(joined.includes("nokey=1") ? "125" : "duration=125\n"));
        } else if (cmd === "ffmpeg") {
          const out = args[args.length - 1];
          if (typeof out === "string" && /\.(jpe?g|mp4)$/i.test(out) && !out.includes("%")) {
            await fsp.mkdir(path.dirname(out), { recursive: true }).catch(() => undefined);
            await fsp.writeFile(out, Buffer.from(`fake:${out}`)).catch(() => undefined);
          }
        }
        child.emit("close", 0);
      })();
    });
    return child;
  }),
}));

vi.mock("../../src/storage/s3.js", () => ({
  storageConfig: vi.fn(async () => ({
    endpoint: "https://r2.example.test",
    bucket: "school",
    accessKeyId: "key",
    secretAccessKey: "secret",
    region: "auto",
    publicBase: "",
  })),
  putObject: vi.fn(async () => undefined),
  getObjectToFile: vi.fn(async () => true),
  getObject: vi.fn(async () => null),
}));

vi.mock("../../src/storage/coverArt.js", () => ({
  renderLessonCover: vi.fn(async () => Buffer.from("rendered-lesson-cover")),
  renderStoryCover: vi.fn(async () => Buffer.from("rendered-story-cover")),
}));

vi.mock("../../src/course/transcribe.js", () => ({
  extractAudio: vi.fn(async () => null),
  transcribeLesson: vi.fn(async () => false),
}));

import { processLesson, generateLessonCovers } from "../../src/storage/videoPipeline.js";
import { renderLessonCover, renderStoryCover } from "../../src/storage/coverArt.js";
import { putObject, type StorageConfig } from "../../src/storage/s3.js";

const CFG: StorageConfig = {
  endpoint: "https://r2.example.test",
  bucket: "school",
  accessKeyId: "key",
  secretAccessKey: "secret",
  region: "auto",
  publicBase: "",
};

function fakeLesson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lesson-1",
    moduleId: "module-1",
    title: "Малиновый чизкейк",
    order: 3,
    sourcePath: "sources/lesson-1.mp4",
    teaserPath: null,
    encryptionKey: null,
    status: "UPLOADED",
    ...overrides,
  };
}

let db: PrismaMock;

beforeEach(() => {
  db = mockPrisma();
  db.model("lesson").findUnique.mockResolvedValue(fakeLesson());
  db.model("lesson").update.mockResolvedValue(undefined);
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("generateLessonCovers — точка входа, общая для обоих мест подключения", () => {
  it("рендерит обе обложки по-русски и грузит их рядом с постером", async () => {
    const frame = Buffer.from("кадр");
    const result = await generateLessonCovers(CFG, "courses/m1/l1", frame, { number: 5, title: "Тирамису", durationMin: 18 });

    expect(result).toEqual({ coverPath: "courses/m1/l1/cover.jpg", storyPath: "courses/m1/l1/story.jpg" });
    expect(renderLessonCover).toHaveBeenCalledWith({ frame, number: 5, title: "Тирамису", durationMin: 18, lang: "ru" });
    expect(renderStoryCover).toHaveBeenCalledWith({ frame, number: 5, title: "Тирамису", durationMin: 18, lang: "ru" });
    expect(putObject).toHaveBeenCalledWith(CFG, "courses/m1/l1/cover.jpg", expect.any(Buffer), "image/jpeg");
    expect(putObject).toHaveBeenCalledWith(CFG, "courses/m1/l1/story.jpg", expect.any(Buffer), "image/jpeg");
  });

  it("падение одного рендера не мешает второму и не бросает исключение", async () => {
    vi.mocked(renderLessonCover).mockRejectedValueOnce(new Error("канвас упал"));

    const result = await generateLessonCovers(CFG, "courses/m1/l1", Buffer.from("x"), { number: 1, title: "Т", durationMin: 5 });

    expect(result.coverPath).toBeNull();
    expect(result.storyPath).toBe("courses/m1/l1/story.jpg");
  });

  it("падение обоих рендеров — обе обложки null, функция не бросает", async () => {
    vi.mocked(renderLessonCover).mockRejectedValueOnce(new Error("канвас упал"));
    vi.mocked(renderStoryCover).mockRejectedValueOnce(new Error("канвас упал"));

    await expect(
      generateLessonCovers(CFG, "courses/m1/l1", Buffer.from("x"), { number: 1, title: "Т", durationMin: 5 })
    ).resolves.toEqual({ coverPath: null, storyPath: null });
  });
});

describe("processLesson — подключение обложек к транскоду", () => {
  it("без тизера: обложки рендерятся один раз из постера урока (3-я секунда)", async () => {
    await processLesson("lesson-1", "https://api.example.test/lessons");

    expect(renderLessonCover).toHaveBeenCalledTimes(1);
    expect(renderStoryCover).toHaveBeenCalledTimes(1);

    const input = vi.mocked(renderLessonCover).mock.calls[0][0];
    expect(input.number).toBe(3);
    expect(input.title).toBe("Малиновый чизкейк");
    expect(input.durationMin).toBe(2); // round(125/60)
    expect(input.lang).toBe("ru");
    // Кадр пришёл из work/poster.jpg (макет ffmpeg), а не из тизера.
    expect(input.frame.toString()).toContain("poster.jpg");
    expect(input.frame.toString()).not.toContain("teaser");

    expect(putObject).toHaveBeenCalledWith(CFG_ANY(), "courses/module-1/lesson-1/cover.jpg", expect.any(Buffer), "image/jpeg");
    expect(putObject).toHaveBeenCalledWith(CFG_ANY(), "courses/module-1/lesson-1/story.jpg", expect.any(Buffer), "image/jpeg");

    const finalUpdate = db
      .model("lesson")
      .update.mock.calls.map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.status === "READY");
    expect(finalUpdate?.data.coverPath).toBe("courses/module-1/lesson-1/cover.jpg");
    expect(finalUpdate?.data.storyPath).toBe("courses/module-1/lesson-1/story.jpg");
  });

  it("с тизером: обложки рендерятся один раз из кадра тизера (готовый десерт), не из постера урока", async () => {
    db.model("lesson").findUnique.mockResolvedValue(fakeLesson({ teaserPath: "sources/lesson-1-teaser.mp4" }));

    await processLesson("lesson-1", "https://api.example.test/lessons");

    // Ровно один вызов на весь processLesson — постер урока НЕ должен ещё раз
    // генерировать обложку поверх той, что уже сделал тизер.
    expect(renderLessonCover).toHaveBeenCalledTimes(1);
    expect(renderStoryCover).toHaveBeenCalledTimes(1);

    const input = vi.mocked(renderLessonCover).mock.calls[0][0];
    expect(input.frame.toString()).toContain("teaser-poster.jpg");
    expect(input.number).toBe(3);
    expect(input.durationMin).toBe(2);

    const teaserUpdate = db
      .model("lesson")
      .update.mock.calls.map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.teaserMp4Path);
    expect(teaserUpdate?.data.coverPath).toBe("courses/module-1/lesson-1/cover.jpg");
    expect(teaserUpdate?.data.storyPath).toBe("courses/module-1/lesson-1/story.jpg");
  });

  it("рендер обложки падает — транскод всё равно завершается READY", async () => {
    vi.mocked(renderLessonCover).mockRejectedValueOnce(new Error("канвас упал"));

    await expect(processLesson("lesson-1", "https://api.example.test/lessons")).resolves.toMatchObject({
      durationSec: 125,
    });

    const finalUpdate = db
      .model("lesson")
      .update.mock.calls.map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.status === "READY");
    expect(finalUpdate?.data.coverPath).toBeUndefined();
    expect(finalUpdate?.data.storyPath).toBe("courses/module-1/lesson-1/story.jpg");
  });
});

/** Мок putObject получает конкретный объект cfg из storageConfig() — сверяем по форме, не по ссылке. */
function CFG_ANY() {
  return expect.objectContaining({ bucket: "school" });
}
