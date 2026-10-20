import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma, logError, logInfo } from "../db.js";
import { storageConfig, putObject, getObjectToFile, type StorageConfig } from "./s3.js";
import { extractAudio, transcribeLesson } from "../course/transcribe.js";
import { renderLessonCover, renderStoryCover, type CoverInput } from "./coverArt.js";

/**
 * ТРАНСКОДИНГ УРОКА В HLS — «как на ютубе, чтобы не тормозило».
 *
 * До трёх дорожек в одном манифесте: 1080p (если исходник не хуже — по
 * КОРОТКОЙ стороне, уроки вертикальные), 720p для нормальной связи и 480p
 * для слабой. Плеер сам переключается по фактической
 * скорости — это и есть adaptive bitrate, ничего изобретать не нужно, HLS
 * умеет из коробки. Дорожки выше исходника не делаем: растянутое видео
 * только весит больше, а чётче не становится. Офлайн-кеш в
 * телефоне качает ТОЛЬКО 480p: весь курс тогда занимает 2–3 ГБ вместо восьми
 * (решение владельца 03.09.2026).
 *
 * СЕГМЕНТЫ ШИФРУЮТСЯ AES-128 штатным механизмом HLS (#EXT-X-KEY), а не
 * самодельной схемой. Так работает офлайн-защита: файлы, вытащенные из
 * телефона, без ключа бесполезны, а ключ выдаёт наш сервер и только своему
 * устройству на 30 дней (см. src/course/lessonAccess.ts).
 *
 * Работает ФОНОМ через createBackgroundJob: проход по получасовому видео — это
 * минуты работы процессора, HTTP-запрос столько не живёт.
 */

/** Длина сегмента. Шесть секунд — компромисс: короче даёт частые запросы и
 *  лишние накладные, длиннее заставляет ждать при переключении качества. */
const SEGMENT_SEC = 6;

/**
 * Дорожки. Битрейты подобраны под кулинарное видео: там мало движения, но
 * важны детали декора (крем, узор), поэтому качество не режем агрессивно —
 * владелец 03.09.2026: «не сжимай сильно». Порядок — от лучшей к худшей:
 * hls.js берёт первую как «полную», а стартует с той, что тянет сеть.
 */
const RENDITIONS = [
  { name: "1080p", width: 1920, height: 1080, videoBitrate: "5000k", audioBitrate: "160k" },
  { name: "720p", width: 1280, height: 720, videoBitrate: "3000k", audioBitrate: "128k" },
  { name: "480p", width: 854, height: 480, videoBitrate: "1200k", audioBitrate: "96k" },
] as const;

type Rendition = (typeof RENDITIONS)[number];

export type Dimensions = { width: number | null; height: number | null };

/**
 * «Качество» исходника — КОРОТКАЯ сторона кадра, а не высота. Уроки школы
 * сняты на телефон ВЕРТИКАЛЬНО (720×1280): по высоте это «1080p не хуже», а
 * по сути — 720p, и делать из него растянутую 1080p-дорожку значит платить
 * трафиком за мыло. Число принимается для обратной совместимости (высота
 * горизонтального видео = его короткая сторона).
 */
export function qualitySide(dims: Dimensions | number | null): number | null {
  if (typeof dims === "number") return dims > 0 ? dims : null;
  if (!dims) return null;
  const sides = [dims.width, dims.height].filter((v): v is number => typeof v === "number" && v > 0);
  return sides.length ? Math.min(...sides) : null;
}

/**
 * Какие дорожки делать для исходника такого качества: не выше него, но 480p —
 * всегда (иначе слабой связи нечего было бы играть). Размер неизвестен —
 * считаем 720, как у типичного телефона.
 */
export function renditionsFor(source: Dimensions | number | null): readonly Rendition[] {
  const q = qualitySide(source) ?? 720;
  const fit = RENDITIONS.filter((r) => r.height <= q);
  return fit.length > 0 ? fit : [RENDITIONS[RENDITIONS.length - 1]];
}

/**
 * Фильтр масштабирования одной дорожки С УЧЁТОМ ОРИЕНТАЦИИ. Рамка дорожки
 * «1280×720» для вертикального кадра должна стать «720×1280»: иначе
 * force_original_aspect_ratio=decrease вписал бы 720×1280 в 1280×720 и
 * получилось бы 405×720 — «720p» в четверть размера. Выражения if(gt(iw,ih))
 * считает сам ffmpeg по исходнику. force_divisible_by=2: у 16:9 при
 * уменьшении до 480 по высоте ширина выходит 853 — нечётная, и libx264
 * отказывается («width not divisible by 2»). Поймано первым же живым
 * прогоном 03.09.2026.
 */
export function scaleFilterFor(r: Pick<Rendition, "width" | "height">): string {
  const w = `'if(gt(iw,ih),${r.width},${r.height})'`;
  const h = `'if(gt(iw,ih),${r.height},${r.width})'`;
  return `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** Имя дорожки, которую качает офлайн-кеш телефона. */
export const OFFLINE_RENDITION = "480p";

export type TranscodeResult = {
  hlsPath: string;
  durationSec: number | null;
  segments: number;
};

/**
 * Потолок на один запуск ffmpeg. Без него битый или усечённый файл, на котором
 * кодировщик встал, вешал задачу НАВСЕГДА: флаг «идёт работа» не снимался, и
 * очередь умирала до перезапуска контейнера, а кнопка «перекодировать заново»
 * отвечала «встало в очередь» и не делала ничего. Урок на два часа — с большим
 * запасом: реальная перекодировка часового видео идёт минуты.
 */
const FFMPEG_TIMEOUT_MS = 2 * 3_600_000;

function run(command: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // nice: ffmpeg жадный до процессора, а на этом же сервере живёт бот,
    // который обязан отвечать клиенткам за секунды. Уступая приоритет, мы
    // теряем минуты на перекодировке и не теряем ни одного ответа в директе.
    const niced = process.platform === "linux" ? ["nice", "-n", "19", command, ...args] : [command, ...args];
    const child = spawn(niced[0], niced.slice(1), { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // Держим хвост: полный вывод ffmpeg на часовом видео — мегабайты.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const killer = setTimeout(() => {
      stderr += `\n[таймаут ${FFMPEG_TIMEOUT_MS / 60000} мин — процесс остановлен]`;
      child.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    killer.unref?.();

    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Есть ли ffmpeg в системе. Проверяется до начала работы, чтобы урок не висел
 *  в PROCESSING из-за отсутствующей программы. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const { code } = await run("ffmpeg", ["-version"]);
    return code === 0;
  } catch {
    return false;
  }
}

async function probeDuration(file: string): Promise<number | null> {
  try {
    const { code, stderr } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    if (code !== 0) return null;
    // ffprobe печатает длительность в stdout, но при -v error stderr пуст —
    // читаем через отдельный вызов ниже, поэтому здесь только страховка.
    const parsed = Number.parseFloat(stderr.trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  } catch {
    return null;
  }
}

/** ffprobe печатает в stdout; run() выше читает только stderr. */
function ffprobeStdout(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", ...args], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

export type MediaProbe = { width: number | null; height: number | null; durationSec: number | null };

/**
 * Размер кадра и длительность одним вызовом ffprobe. null — файл не
 * читается вовсе (нет moov atom у оборванной загрузки, не видео, нет ffprobe).
 * Панель импорта этим отличает «повреждён» от «просто большой».
 */
export async function probeMedia(file: string): Promise<MediaProbe | null> {
  const out = await ffprobeStdout([
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]);
  if (out === null) return null;
  const pick = (key: string): number | null => {
    const m = new RegExp(`^${key}=([\\d.]+)`, "m").exec(out);
    const v = m ? Number.parseFloat(m[1]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const width = pick("width");
  const height = pick("height");
  const duration = pick("duration");
  if (width === null && height === null && duration === null) return null;
  return {
    width: width === null ? null : Math.round(width),
    height: height === null ? null : Math.round(height),
    // Дробная длительность нужна подбору файлов (Telegram отбрасывает дробь).
    durationSec: duration,
  };
}

/** Есть ли ffprobe — один раз на процесс: панель зовёт это на каждый файл экспорта. */
let ffprobeKnown: Promise<boolean> | null = null;
export function ffprobeAvailable(): Promise<boolean> {
  ffprobeKnown ??= ffprobeStdout(["-version"]).then((out) => out !== null);
  return ffprobeKnown;
}

/** Размер кадра исходника — чтобы не делать дорожки выше него. */
async function probeDimensions(file: string): Promise<Dimensions | null> {
  const probed = await probeMedia(file);
  return probed && (probed.width || probed.height) ? { width: probed.width, height: probed.height } : null;
}

function probeDurationStdout(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const parsed = Number.parseFloat(out.trim());
      resolve(Number.isFinite(parsed) ? Math.round(parsed) : null);
    });
  });
}

/**
 * Один прогон ffmpeg: исходник → две дорожки HLS с шифрованием.
 *
 * `keyUri` попадает В МАНИФЕСТ как есть — это адрес нашего сервера, у которого
 * плеер спросит ключ. Сам ключ в бакет НЕ кладётся никогда: он живёт в базе
 * (Lesson.encryptionKey) и отдаётся только после проверки устройства.
 */
async function transcodeToHls(
  sourceFile: string,
  outDir: string,
  key: Buffer,
  keyUri: string,
  renditions: readonly Rendition[] = RENDITIONS
): Promise<void> {
  const keyFile = path.join(outDir, "enc.key");
  const keyInfoFile = path.join(outDir, "enc.keyinfo");
  const iv = crypto.randomBytes(16).toString("hex");
  await fs.promises.writeFile(keyFile, key);
  // Формат keyinfo: строка 1 — URI для манифеста, строка 2 — путь к файлу
  // ключа на диске, строка 3 — IV.
  await fs.promises.writeFile(keyInfoFile, `${keyUri}\n${keyFile}\n${iv}\n`);

  const filter = [
    `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join("")}`,
    ...renditions.map((r, i) => `[v${i}]${scaleFilterFor(r)}[v${i}out]`),
  ].join(";");

  const args = ["-y", "-i", sourceFile, "-filter_complex", filter];
  renditions.forEach((r, i) => {
    args.push(
      "-map",
      `[v${i}out]`,
      `-c:v:${i}`,
      "libx264",
      `-b:v:${i}`,
      r.videoBitrate,
      // Потолок на 20% выше среднего: сложные кадры (мелкий узор) не «мылит».
      `-maxrate:v:${i}`,
      `${Math.round(Number.parseInt(r.videoBitrate) * 1.2)}k`,
      `-bufsize:v:${i}`,
      `${Number.parseInt(r.videoBitrate) * 2}k`,
      "-preset",
      "veryfast",
      // Оставляем ядро боту: без ограничения ffmpeg забирает все, и ответы в
      // директе начинают приходить через десятки секунд.
      "-threads",
      String(Math.max(1, (os.cpus().length || 2) - 1)),
      "-profile:v",
      "main",
      // Телефонные записи бывают в 10-бит или yuvj — старые Android такое не
      // играют. Приводим к самому совместимому формату.
      "-pix_fmt",
      "yuv420p",
      "-sc_threshold",
      "0",
      // Ключевой кадр строго на границе сегмента — иначе плеер не сможет
      // переключить качество без рывка.
      "-g",
      String(SEGMENT_SEC * 25),
      "-keyint_min",
      String(SEGMENT_SEC * 25)
    );
    args.push("-map", "a:0?", `-c:a:${i}`, "aac", `-b:a:${i}`, r.audioBitrate, "-ac", "2");
  });

  args.push(
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SEC),
    "-hls_playlist_type",
    "vod",
    "-hls_key_info_file",
    keyInfoFile,
    "-hls_segment_filename",
    path.join(outDir, "%v", "seg_%03d.ts"),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    renditions.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(" "),
    path.join(outDir, "%v", "index.m3u8")
  );

  for (const r of renditions) {
    await fs.promises.mkdir(path.join(outDir, r.name), { recursive: true });
  }

  const { code, stderr } = await run("ffmpeg", args);
  if (code !== 0) {
    throw new Error(`ffmpeg вернул ${code}: ${stderr.slice(-1200)}`);
  }
  // Ключ с диска убираем сразу: в бакет он не поедет и на сервере не нужен.
  await fs.promises.rm(keyFile, { force: true });
  await fs.promises.rm(keyInfoFile, { force: true });
}

async function uploadDir(cfg: StorageConfig, dir: string, prefix: string): Promise<number> {
  let uploaded = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      uploaded += await uploadDir(cfg, full, key);
      continue;
    }
    const body = await fs.promises.readFile(full);
    const contentType = entry.name.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : entry.name.endsWith(".ts")
        ? "video/mp2t"
        : "application/octet-stream";
    await putObject(cfg, key, body, contentType);
    uploaded += 1;
  }
  return uploaded;
}

/** Кадр-обложка в хранилище; null — не получилось (ffmpeg отказал, файл странный). */
async function makePoster(
  cfg: StorageConfig,
  sourceFile: string,
  work: string,
  prefix: string
): Promise<{ key: string; frame: Buffer } | null> {
  const posterFile = path.join(work, "poster.jpg");
  try {
    const { code, stderr } = await run("ffmpeg", [
      "-y",
      "-ss", "3",
      "-i", sourceFile,
      "-frames:v", "1",
      "-vf", "scale=480:-2",
      "-q:v", "4",
      posterFile,
    ]);
    if (code !== 0) throw new Error(`ffmpeg poster: код ${code}: ${stderr.slice(-300)}`);
    const body = await fs.promises.readFile(posterFile);
    const key = `${prefix}/poster.jpg`;
    await putObject(cfg, key, body, "image/jpeg");
    return { key, frame: body };
  } catch (err) {
    logError("video:poster", err);
    return null;
  }
}

/** Метаданные урока, нужные обложкам (см. `apps/api/src/storage/coverArt.ts`). */
export type LessonCoverMeta = { number: number; title: string; durationMin: number };

/**
 * ОБЛОЖКИ УРОКА — 1280×720 (списки/панель/og:image) и 1080×1920 (геройский
 * экран/шаринг в сторис). Общая точка входа для обоих мест, где появляется
 * кадр-источник (тизер или постер урока — см. вызовы ниже), и для разового
 * бэкфилла старых уроков (`scripts/backfill-covers.ts`).
 *
 * Названия десертов и подписи на обложке — по-русски всегда (решение
 * владельца: контент не переводится, переключается только интерфейс), поэтому
 * `lang` здесь не параметр, а константа.
 *
 * Рендер вторичен: ошибка одной или обеих обложек логируется и НЕ бросается
 * наверх — транскод урока не должен падать из-за декоративной картинки.
 */
export async function generateLessonCovers(
  cfg: StorageConfig,
  prefix: string,
  frame: Buffer,
  meta: LessonCoverMeta
): Promise<{ coverPath: string | null; storyPath: string | null }> {
  const input: CoverInput = { frame, number: meta.number, title: meta.title, durationMin: meta.durationMin, lang: "ru" };

  let coverPath: string | null = null;
  try {
    const cover = await renderLessonCover(input);
    const key = `${prefix}/cover.jpg`;
    await putObject(cfg, key, cover, "image/jpeg");
    coverPath = key;
  } catch (err) {
    logError("video:cover", err);
  }

  let storyPath: string | null = null;
  try {
    const story = await renderStoryCover(input);
    const key = `${prefix}/story.jpg`;
    await putObject(cfg, key, story, "image/jpeg");
    storyPath = key;
  } catch (err) {
    logError("video:story", err);
  }

  return { coverPath, storyPath };
}

/** Тизер: короткая сторона 480 — и для вертикального, и для горизонтального. */
const TEASER_SCALE = "scale=w='if(gt(iw,ih),-2,480)':h='if(gt(iw,ih),480,-2)'";

/**
 * ТИЗЕР УРОКА — один mp4 480p и обложка с его последнего кадра.
 *
 * Тизер в канале школы — смонтированный ролик на 9–24 с с готовым десертом в
 * конце: как обложка он честнее кадра с третьей секунды урока (там обычно
 * миска с мукой). HLS для 20 секунд — лишнее: один прогрессивный mp4 играет
 * везде и весит меньше манифеста с сегментами. Битрейт подобран так, чтобы
 * 24 с уложились в 3 МБ. Не шифруется — это анонс, а не содержимое курса.
 */
async function processTeaser(
  cfg: StorageConfig,
  lessonId: string,
  teaserPath: string,
  work: string,
  prefix: string,
  coverMeta: LessonCoverMeta
): Promise<void> {
  const src = path.join(work, "teaser-src" + (path.extname(teaserPath) || ".mp4"));
  if (!(await getObjectToFile(cfg, teaserPath, src))) throw new Error(`тизер ${teaserPath} не найден в хранилище`);

  const out = path.join(work, "teaser.mp4");
  const { code, stderr } = await run("ffmpeg", [
    "-y",
    "-i", src,
    "-vf", TEASER_SCALE,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-b:v", "800k",
    "-maxrate", "1000k",
    "-bufsize", "1600k",
    "-c:a", "aac",
    "-b:a", "64k",
    "-ac", "2",
    "-movflags", "+faststart",
    "-threads", String(Math.max(1, (os.cpus().length || 2) - 1)),
    out,
  ]);
  if (code !== 0) throw new Error(`ffmpeg teaser: код ${code}: ${stderr.slice(-600)}`);
  const teaserKey = `${prefix}/teaser.mp4`;
  await putObject(cfg, teaserKey, await fs.promises.readFile(out), "video/mp4", "private, max-age=0");

  // Обложка — секунда до конца тизера: там готовое изделие. Кадр тизера —
  // приоритетный источник для карточек/сторис (готовый десерт, а не миска с
  // мукой из середины урока), поэтому именно отсюда рендерим cover.jpg/story.jpg.
  let posterPath: string | null = null;
  let coverPath: string | null = null;
  let storyPath: string | null = null;
  const posterFile = path.join(work, "teaser-poster.jpg");
  const poster = await run("ffmpeg", ["-y", "-sseof", "-1", "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", posterFile]);
  if (poster.code === 0) {
    const frame = await fs.promises.readFile(posterFile);
    const key = `${prefix}/poster.jpg`;
    await putObject(cfg, key, frame, "image/jpeg");
    posterPath = key;
    const covers = await generateLessonCovers(cfg, prefix, frame, coverMeta);
    coverPath = covers.coverPath;
    storyPath = covers.storyPath;
  } else {
    logError("video:teaserPoster", new Error(`ffmpeg: код ${poster.code}: ${poster.stderr.slice(-300)}`));
  }

  await prisma.lesson.update({
    where: { id: lessonId },
    data: {
      teaserMp4Path: teaserKey,
      ...(posterPath ? { posterPath } : {}),
      ...(coverPath ? { coverPath } : {}),
      ...(storyPath ? { storyPath } : {}),
    },
  });
  logInfo("video:teaser", `урок ${lessonId}: тизер готов${posterPath ? ", обложка с тизера" : ""}`);
}

/**
 * Полный цикл для одного урока: забрать исходник из бакета, перекодировать,
 * залить результат, записать путь и длительность.
 *
 * Урок всё время виден в панели со своим статусом, поэтому владелец понимает,
 * что происходит, и видит причину, если не вышло.
 */
export async function processLesson(lessonId: string, keyUriBase: string): Promise<TranscodeResult> {
  const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
  if (!lesson) throw new Error(`Урок ${lessonId} не найден`);
  if (!lesson.sourcePath) throw new Error(`У урока ${lessonId} нет исходного файла`);

  const cfg = await storageConfig();
  if (!cfg) throw new Error("Хранилище не настроено — заполните ключи R2 в настройках панели");
  if (!(await ffmpegAvailable())) {
    throw new Error("ffmpeg не установлен на сервере — без него видео не перекодировать");
  }

  await prisma.lesson.update({ where: { id: lessonId }, data: { status: "PROCESSING" } });

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lesson-"));
  try {
    // Скачиваем сразу на диск: исходник урока — сотни мегабайт, и держать его
    // в памяти незачем, ffmpeg всё равно читает с диска.
    const sourceFile = path.join(work, "source" + path.extname(lesson.sourcePath));
    const downloaded = await getObjectToFile(cfg, lesson.sourcePath, sourceFile);
    if (!downloaded) throw new Error(`Исходник ${lesson.sourcePath} не найден в хранилище`);

    // Ключ шифрования: один на урок, генерируется здесь и больше нигде не
    // появляется в открытом виде, кроме базы.
    const key = lesson.encryptionKey ? Buffer.from(lesson.encryptionKey, "base64") : crypto.randomBytes(16);

    const outDir = path.join(work, "out");
    await fs.promises.mkdir(outDir, { recursive: true });
    const dims = await probeDimensions(sourceFile);
    await transcodeToHls(sourceFile, outDir, key, `${keyUriBase}/${lessonId}/key`, renditionsFor(dims));

    const prefix = `courses/${lesson.moduleId}/${lessonId}`;
    const segments = await uploadDir(cfg, outDir, prefix);
    const durationSec = (await probeDurationStdout(sourceFile)) ?? (await probeDuration(sourceFile));

    // ОБЛОЖКА — кадр с третьей секунды. Список уроков с картинками читается
    // с телефона за секунду, без них — как оглавление. Не вышло — не беда:
    // приложение покажет заглушку, урок от этого не пострадает.
    const poster = await makePoster(cfg, sourceFile, work, prefix);
    const posterPath = poster?.key ?? null;

    // ОБЛОЖКИ 16:9/9:16 — только если у урока НЕТ тизера: иначе их сгенерирует
    // processTeaser ниже из кадра готового десерта, а этот постер («миска,
    // весы» — типичный кадр середины урока) для карточек и сторис хуже.
    const coverMeta: LessonCoverMeta = { number: lesson.order, title: lesson.title, durationMin: Math.round((durationSec ?? 0) / 60) };
    let coverPath: string | null = null;
    let storyPath: string | null = null;
    if (!lesson.teaserPath && poster) {
      const covers = await generateLessonCovers(cfg, prefix, poster.frame, coverMeta);
      coverPath = covers.coverPath;
      storyPath = covers.storyPath;
    }

    const hlsPath = `${prefix}/master.m3u8`;
    await prisma.lesson.update({
      where: { id: lessonId },
      data: {
        hlsPath,
        durationSec,
        posterPath,
        ...(coverPath ? { coverPath } : {}),
        ...(storyPath ? { storyPath } : {}),
        encryptionKey: key.toString("base64"),
        status: "READY",
      },
    });

    // ТИЗЕР — после READY, как и расшифровка: короткий ролик не должен
    // задерживать урок, а его неудача — отменять успешную перекодировку.
    if (lesson.teaserPath) {
      await processTeaser(cfg, lessonId, lesson.teaserPath, work, prefix, coverMeta).catch((err) => logError("video:teaser", err));
    }

    // РАСШИФРОВКА — после того, как урок уже помечен READY: ученицы могут
    // смотреть, не дожидаясь текста, а помощник в чате поумнеет через минуту.
    // Ошибка расшифровки не должна отменять успешную перекодировку, поэтому
    // она вне основного try и ничего не бросает наверх.
    try {
      const audio = await extractAudio(sourceFile, work);
      if (audio) {
        // Дорожку сохраняем рядом с HLS: владелец расшифровывает уроки сам,
        // бесплатно, через Google AI Studio в браузере (решение 03.09.2026) —
        // ему нужен файл, а не API-вызов.
        await putObject(cfg, `${prefix}/audio.mp3`, await fs.promises.readFile(audio), "audio/mpeg", "private, max-age=0").catch(
          (err) => logError("video:audioUpload", err)
        );
        await transcribeLesson(lessonId, audio);
      }
    } catch (err) {
      logError("video:transcribe", err);
    }
    logInfo("video:transcode", `урок ${lessonId}: ${segments} файлов, ${durationSec ?? "?"} сек`);
    return { hlsPath, durationSec, segments };
  } catch (err) {
    await prisma.lesson
      .update({ where: { id: lessonId }, data: { status: "FAILED" } })
      .catch((e) => logError("video:transcode:markFailed", e));
    throw err;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
