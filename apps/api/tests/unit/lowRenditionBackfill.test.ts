import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executePlan, planLesson, type BackfillLesson, type HlsStore } from "../../src/storage/lowRenditionBackfill.js";
import { renditionsFor, transcodeToHls } from "../../src/storage/videoPipeline.js";
import {
  decryptSegment,
  looksLikeMpegTs,
  parseKeyTags,
  parseMaster,
  parseVariant,
  segmentIv,
} from "../../src/storage/hlsMaster.js";

/**
 * Живой прогон досоздания лёгких дорожек на НАСТОЯЩЕМ ffmpeg и «бакете» в
 * папке диска: старый урок (720p + 480p, AES-128) → +360p +240p тем же
 * ключом и IV. Без ffmpeg в системе набор пропускается.
 */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
/** Где работать; в песочнице без записи в системный temp — LOWREND_TEST_TMP=<папка>. */
const TMP_BASE = process.env.LOWREND_TEST_TMP || os.tmpdir();

function dirStore(root: string): HlsStore & { puts: string[] } {
  const puts: string[] = [];
  const file = (key: string) => path.join(root, ...key.split("/"));
  return {
    puts,
    get: async (key) => (fs.existsSync(file(key)) ? fs.promises.readFile(file(key)) : null),
    getToFile: async (key, dest) => {
      if (!fs.existsSync(file(key))) return false;
      await fs.promises.copyFile(file(key), dest);
      return true;
    },
    put: async (key, body) => {
      puts.push(key);
      await fs.promises.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.promises.writeFile(file(key), body);
    },
    exists: async (key) => fs.existsSync(file(key)),
  };
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const e of await fs.promises.readdir(from, { withFileTypes: true })) {
    if (e.isDirectory()) await copyDir(path.join(from, e.name), path.join(to, e.name));
    else await fs.promises.copyFile(path.join(from, e.name), path.join(to, e.name));
  }
}

function ffprobeSize(file: string): string {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  // ffprobe may print the stream twice (stream + MPEG-TS program): take the first line.
  return r.stdout.split(/\r?\n/).filter(Boolean)[0] ?? "";
}

describe.skipIf(!hasFfmpeg)("досоздание 360p/240p старому уроку (живой ffmpeg)", () => {
  let tmp: string;
  let bucket: string;
  let oldLessonDir: string;
  const key = crypto.randomBytes(16);
  const keyUri = "https://school.example/api/course/lessons/L1/key";
  let oldMaster = "";
  let old480 = "";

  beforeAll(async () => {
    tmp = await fs.promises.mkdtemp(path.join(TMP_BASE, "lowrend-test-"));
    bucket = path.join(tmp, "bucket");
    const src = path.join(tmp, "source.mp4");
    // 13 секунд вертикального видео со звуком — как урок, снятый на телефон.
    const gen = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=720x1280:rate=25:duration=13",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=13",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        src,
      ],
      { windowsHide: true },
    );
    expect(gen.status).toBe(0);

    // «Старый урок»: только 720p и 480p, как все 31 урок на 16.11.2026.
    oldLessonDir = path.join(tmp, "old");
    await fs.promises.mkdir(oldLessonDir, { recursive: true });
    const legacy = renditionsFor({ width: 720, height: 1280 }).filter((r) => r.name === "720p" || r.name === "480p");
    await transcodeToHls(src, oldLessonDir, key, keyUri, legacy, { threads: 2 });
    // ffmpeg на Windows пишет в master обратный слеш; на сервере (Linux) — "/".
    const m = path.join(oldLessonDir, "master.m3u8");
    await fs.promises.writeFile(m, (await fs.promises.readFile(m, "utf8")).replace(/\\/g, "/"));

    for (const id of ["L1", "L2"]) await copyDir(oldLessonDir, path.join(bucket, "courses", "m1", id));
    await fs.promises.mkdir(path.join(bucket, "uploads"), { recursive: true });
    await fs.promises.copyFile(src, path.join(bucket, "uploads", "L1.mp4"));
    oldMaster = await fs.promises.readFile(path.join(oldLessonDir, "master.m3u8"), "utf8");
    old480 = await fs.promises.readFile(path.join(oldLessonDir, "480p", "index.m3u8"), "utf8");
  }, 120_000);

  afterAll(async () => {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  const lesson = (id: string, sourcePath: string | null, k = key): BackfillLesson => ({
    id,
    hlsPath: `courses/m1/${id}/master.m3u8`,
    sourcePath,
    encryptionKey: k.toString("base64"),
  });

  it("из исходника: +360p +240p тем же ключом и IV, master дописан, старое не тронуто", async () => {
    const store = dirStore(bucket);
    const l = lesson("L1", "uploads/L1.mp4");
    const plan = await planLesson(l, store);
    expect(plan.kind).toBe("todo");
    if (plan.kind !== "todo") return;
    expect(plan.missing.map((r) => r.name)).toEqual(["360p", "240p"]);
    expect(plan.from).toBe("source");
    expect(plan.reference).toBe("480p");
    expect(plan.iv).toBe(parseKeyTags(old480)[0].iv);

    const res = await executePlan(l, plan, store, { threads: 2, workDir: tmp });
    expect(res.added).toEqual(["360p", "240p"]);

    // master — последним, старые дорожки и их файлы не перезаписаны.
    expect(store.puts.at(-1)).toBe(l.hlsPath);
    expect(store.puts.some((k) => /\/(720p|480p)\//.test(k))).toBe(false);
    const master = await fs.promises.readFile(path.join(bucket, "courses/m1/L1/master.m3u8"), "utf8");
    expect(master.startsWith(oldMaster.trimEnd())).toBe(true);
    expect(parseMaster(master).map((e) => e.name)).toEqual(["720p", "480p", "360p", "240p"]);

    // Новая дорожка: тот же адрес ключа и IV, сегмент открывается ключом урока.
    const p240 = await fs.promises.readFile(path.join(bucket, "courses/m1/L1/240p/index.m3u8"), "utf8");
    const [tag] = parseKeyTags(p240);
    expect(tag).toEqual(parseKeyTags(old480)[0]);
    const v = parseVariant(p240);
    const seg = await fs.promises.readFile(path.join(bucket, "courses/m1/L1/240p", v.segments[0]));
    const plain = decryptSegment(seg, key, segmentIv(tag, v.mediaSequence, 0));
    expect(looksLikeMpegTs(plain)).toBe(true);
    const plainFile = path.join(tmp, "240p-seg0.ts");
    await fs.promises.writeFile(plainFile, plain);
    expect(ffprobeSize(plainFile)).toBe("240,426");
    // Сегменты лёгкой дорожки режутся там же, где у 480p: ABR переключает без рывка.
    expect(v.segments.length).toBe(parseVariant(old480).segments.length);
  }, 180_000);

  it("второй прогон: «уже есть», ничего не пишет", async () => {
    const store = dirStore(bucket);
    expect(await planLesson(lesson("L1", "uploads/L1.mp4"), store)).toEqual({ kind: "done" });
    expect(store.puts).toEqual([]);
  });

  it("исходника нет — собирает из расшифрованной 480p", async () => {
    const store = dirStore(bucket);
    const l = lesson("L2", "uploads/gone.mp4");
    const plan = await planLesson(l, store);
    expect(plan.kind === "todo" && plan.from).toBe("rendition");
    if (plan.kind !== "todo") return;
    await executePlan(l, plan, store, { threads: 2, workDir: tmp });
    const master = await fs.promises.readFile(path.join(bucket, "courses/m1/L2/master.m3u8"), "utf8");
    expect(parseMaster(master).map((e) => e.name)).toEqual(["720p", "480p", "360p", "240p"]);
  }, 180_000);

  it("ключ в базе не тот — урок не трогаем", async () => {
    await copyDir(oldLessonDir, path.join(bucket, "courses", "m1", "L3"));
    const store = dirStore(bucket);
    const plan = await planLesson(lesson("L3", null, crypto.randomBytes(16)), store);
    expect(plan).toEqual({ kind: "impossible", reason: "ключ в базе не расшифровывает готовые сегменты" });
    expect(store.puts).toEqual([]);
  });

  it("урок поменяли во время кодирования — master не пишется", async () => {
    await copyDir(oldLessonDir, path.join(bucket, "courses", "m1", "L4"));
    const store = dirStore(bucket);
    const l = lesson("L4", null);
    const plan = await planLesson(l, store);
    if (plan.kind !== "todo") throw new Error("ожидали todo");
    await expect(executePlan(l, plan, store, { threads: 2, workDir: tmp, recheck: async () => "статус PROCESSING" })).rejects.toThrow(
      /PROCESSING/,
    );
    expect(store.puts).toEqual([]);
    const master = await fs.promises.readFile(path.join(bucket, "courses/m1/L4/master.m3u8"), "utf8");
    expect(master).toBe(oldMaster);
  }, 180_000);
});
