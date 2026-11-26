import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptSegment,
  looksLikeMpegTs,
  mergeMaster,
  missingVariants,
  parseKeyTags,
  parseMaster,
  parseVariant,
  segmentIv,
  type KeyTag,
} from "./hlsMaster.js";
import { LOW_RENDITIONS, OFFLINE_RENDITION, transcodeToHls, type Rendition } from "./videoPipeline.js";
import { getObject, getObjectToFile, headObject, putObject, type StorageConfig } from "./s3.js";

/**
 * ДОСОЗДАНИЕ ЛЁГКИХ ДОРОЖЕК (360p, 240p) УЖЕ ГОТОВЫМ УРОКАМ.
 *
 * Новые уроки получают их при перекодировке (renditionsFor), а 31 старый урок
 * живёт с 720p + 480p, и на канале ниже 1.5 Мбит/с плеер у них встаёт. Этот
 * модуль для одного урока:
 *  1) смотрит, каких лёгких дорожек нет в master.m3u8;
 *  2) берёт ключ урока из базы и IV/адрес ключа из готовой дорожки (480p) и
 *     ПРОВЕРЯЕТ, что этим ключом её первый сегмент правда расшифровывается —
 *     иначе новые дорожки вышли бы неиграемыми;
 *  3) кодирует ТОЛЬКО недостающие дорожки из исходника (нет исходника —
 *     из расшифрованной 480p) тем же ключом и тем же IV;
 *  4) заливает сегменты, потом плейлисты дорожек и ПОСЛЕДНИМ — master.m3u8
 *     с дописанными строками. Оборвалось посередине — master прежний, плеер
 *     о недоделанной дорожке не знает, повторный запуск доделает.
 *
 * Готовые дорожки, ключ и база не меняются никогда: на них держатся живые
 * просмотры и офлайн-копии в телефонах (480p, OFFLINE_RENDITION).
 */

/** Доступ к хранилищу — интерфейсом, чтобы тест гонял всё на папке диска. */
export type HlsStore = {
  get(key: string): Promise<Buffer | null>;
  getToFile(key: string, file: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

export function r2Store(cfg: StorageConfig): HlsStore {
  return {
    get: (key) => getObject(cfg, key),
    getToFile: (key, file) => getObjectToFile(cfg, key, file),
    put: (key, body, contentType, cacheControl) => putObject(cfg, key, body, contentType, cacheControl),
    exists: async (key) => (await headObject(cfg, key)) !== null,
  };
}

export type BackfillLesson = {
  id: string;
  hlsPath: string;
  sourcePath: string | null;
  encryptionKey: string | null;
};

export type LessonPlan =
  | { kind: "done" }
  | {
      kind: "todo";
      missing: Rendition[];
      /** Готовая дорожка-образец: с неё берутся IV и адрес ключа, её длительность — эталон. */
      reference: string;
      keyUri: string;
      iv: string | null;
      referenceDurationSec: number;
      from: "source" | "rendition";
    }
  | { kind: "impossible"; reason: string };

const M3U8 = "application/vnd.apple.mpegurl";
/** Манифесты не кешируем: master.m3u8 этим скриптом меняется на месте. */
const MANIFEST_CACHE = "private, max-age=0";
/** Насколько длительность новой дорожки может разойтись с образцом. */
const DURATION_TOLERANCE_SEC = 2;

export function hlsPrefix(hlsPath: string): string {
  return hlsPath.replace(/\/master\.m3u8$/, "");
}

/**
 * ЧТО ДЕЛАТЬ С УРОКОМ — только чтение (это же и есть сухой прогон).
 * Скачивает master, плейлист образца и ОДИН его сегмент для проверки ключа.
 */
export async function planLesson(
  lesson: BackfillLesson,
  store: HlsStore,
  wanted: readonly Rendition[] = LOW_RENDITIONS,
): Promise<LessonPlan> {
  if (!/\/master\.m3u8$/.test(lesson.hlsPath))
    return { kind: "impossible", reason: `странный hlsPath «${lesson.hlsPath}»` };
  const masterBuf = await store.get(lesson.hlsPath);
  if (!masterBuf) return { kind: "impossible", reason: "master.m3u8 не найден в хранилище" };
  const master = masterBuf.toString("utf8");

  let entries;
  let missingNames: string[];
  try {
    entries = parseMaster(master);
    missingNames = missingVariants(
      master,
      wanted.map((r) => r.name),
    );
  } catch (err) {
    return { kind: "impossible", reason: (err as Error).message };
  }
  if (missingNames.length === 0) return { kind: "done" };
  if (entries.length === 0) return { kind: "impossible", reason: "в master.m3u8 нет ни одной дорожки" };

  if (!lesson.encryptionKey) return { kind: "impossible", reason: "у урока нет ключа шифрования в базе" };
  const key = Buffer.from(lesson.encryptionKey, "base64");
  if (key.length !== 16) return { kind: "impossible", reason: "ключ урока в базе не 16 байт" };

  // Образец — офлайн-дорожка 480p (она есть у всех уроков), иначе самая лёгкая.
  const byBandwidth = [...entries].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0));
  const reference = entries.find((e) => e.name === OFFLINE_RENDITION) ?? byBandwidth[0];
  const prefix = hlsPrefix(lesson.hlsPath);
  const refBuf = await store.get(`${prefix}/${reference.uri}`);
  if (!refBuf) return { kind: "impossible", reason: `нет плейлиста образца ${reference.uri}` };
  const refText = refBuf.toString("utf8");
  const ref = parseVariant(refText);
  if (!ref.ended || ref.segments.length === 0)
    return { kind: "impossible", reason: `плейлист ${reference.uri} неполный` };

  const tags = parseKeyTags(refText);
  if (tags.length === 0)
    return { kind: "impossible", reason: `дорожка ${reference.name} без шифрования — разобрать руками` };
  const distinct = new Set(tags.map((t) => `${t.method}|${t.uri}|${t.iv}`));
  if (distinct.size > 1)
    return { kind: "impossible", reason: `в ${reference.name} несколько ключей — не поддерживается` };
  const tag: KeyTag = tags[0];
  if (tag.method !== "AES-128" || !tag.uri)
    return { kind: "impossible", reason: `шифрование ${tag.method} не AES-128` };
  if (tag.iv !== null && !/^[0-9a-f]{32}$/.test(tag.iv))
    return { kind: "impossible", reason: "IV в плейлисте не 128 бит" };

  // Ключ из базы ОБЯЗАН открывать готовые сегменты: иначе новые дорожки,
  // зашифрованные им же, плеер не откроет, а мы бы узнали об этом от учениц.
  const firstSeg = await store.get(`${prefix}/${reference.name}/${ref.segments[0]}`);
  if (!firstSeg) return { kind: "impossible", reason: `нет сегмента ${reference.name}/${ref.segments[0]}` };
  let plain: Buffer | null = null;
  try {
    plain = decryptSegment(firstSeg, key, segmentIv(tag, ref.mediaSequence, 0));
  } catch {
    plain = null;
  }
  if (!plain || !looksLikeMpegTs(plain)) {
    return { kind: "impossible", reason: "ключ в базе не расшифровывает готовые сегменты" };
  }

  const from = lesson.sourcePath && (await store.exists(lesson.sourcePath)) ? "source" : "rendition";
  return {
    kind: "todo",
    missing: wanted.filter((r) => missingNames.includes(r.name)),
    reference: reference.name,
    keyUri: tag.uri,
    iv: tag.iv,
    referenceDurationSec: ref.durationSec,
    from,
  };
}

/** Расшифровать дорожку-образец в один .ts — запасной исходник, если оригинала нет. */
async function decryptReferenceToFile(
  store: HlsStore,
  prefix: string,
  reference: string,
  key: Buffer,
  file: string,
): Promise<void> {
  const refBuf = await store.get(`${prefix}/${reference}/index.m3u8`);
  if (!refBuf) throw new Error(`нет плейлиста ${reference}`);
  const text = refBuf.toString("utf8");
  const ref = parseVariant(text);
  const [tag] = parseKeyTags(text);
  const out = fs.createWriteStream(file);
  try {
    for (let i = 0; i < ref.segments.length; i++) {
      const seg = await store.get(`${prefix}/${reference}/${ref.segments[i]}`);
      if (!seg) throw new Error(`нет сегмента ${reference}/${ref.segments[i]}`);
      const plain = tag ? decryptSegment(seg, key, segmentIv(tag, ref.mediaSequence, i)) : seg;
      // MPEG-TS склеивается простой конкатенацией — так и устроен формат.
      if (!out.write(plain)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
}

export type ExecuteOptions = {
  /** Потоков ffmpeg; по умолчанию 2 — на сервере живёт бот. */
  threads?: number;
  /**
   * Проверка ПЕРЕД заливкой и перед записью master: урок не удалили, не
   * перекодировали, ключ прежний. Вернула причину — урок пропускается.
   */
  recheck?: () => Promise<string | null>;
  log?: (msg: string) => void;
  /** Где держать исходник и выход ffmpeg; по умолчанию системная временная папка. */
  workDir?: string;
};

export type ExecuteResult = { added: string[]; uploaded: number; source: "source" | "rendition" };

/**
 * ДОДЕЛАТЬ УРОК ПО ПЛАНУ: кодирование, заливка, master последним.
 * Бросает с понятной причиной; master при этом не тронут.
 */
export async function executePlan(
  lesson: BackfillLesson,
  plan: Extract<LessonPlan, { kind: "todo" }>,
  store: HlsStore,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const log = opts.log ?? (() => undefined);
  const key = Buffer.from(lesson.encryptionKey ?? "", "base64");
  const prefix = hlsPrefix(lesson.hlsPath);
  const work = await fs.promises.mkdtemp(path.join(opts.workDir ?? os.tmpdir(), "lowrend-"));
  try {
    let input: string;
    if (plan.from === "source" && lesson.sourcePath) {
      input = path.join(work, "source" + (path.extname(lesson.sourcePath) || ".mp4"));
      log(`скачиваю исходник ${lesson.sourcePath}`);
      if (!(await store.getToFile(lesson.sourcePath, input))) throw new Error(`исходник ${lesson.sourcePath} пропал`);
    } else {
      input = path.join(work, "reference.ts");
      log(`исходника нет — собираю из ${plan.reference}`);
      await decryptReferenceToFile(store, prefix, plan.reference, key, input);
    }

    const outDir = path.join(work, "out");
    await fs.promises.mkdir(outDir, { recursive: true });
    log(`кодирую ${plan.missing.map((r) => r.name).join(", ")}`);
    await transcodeToHls(input, outDir, key, plan.keyUri, plan.missing, { iv: plan.iv, threads: opts.threads ?? 2 });

    // Что вышло — проверяем ДО заливки: полный плейлист, тот же ключ и IV,
    // длительность как у образца (иначе исходник не тот, что у урока).
    for (const r of plan.missing) {
      const text = await fs.promises.readFile(path.join(outDir, r.name, "index.m3u8"), "utf8");
      const v = parseVariant(text);
      if (!v.ended || v.segments.length === 0) throw new Error(`${r.name}: ffmpeg дал неполный плейлист`);
      const [tag] = parseKeyTags(text);
      if (!tag || tag.uri !== plan.keyUri || tag.iv !== plan.iv)
        throw new Error(`${r.name}: ключ/IV в плейлисте не совпали с уроком`);
      if (Math.abs(v.durationSec - plan.referenceDurationSec) > DURATION_TOLERANCE_SEC) {
        throw new Error(
          `${r.name}: длительность ${v.durationSec.toFixed(1)} с против ${plan.referenceDurationSec.toFixed(1)} с у ${plan.reference} — исходник не тот`,
        );
      }
    }
    const addedMaster = await fs.promises.readFile(path.join(outDir, "master.m3u8"), "utf8");

    const stale = opts.recheck ? await opts.recheck() : null;
    if (stale) throw new Error(`урок изменился, пока кодировали: ${stale}`);
    // Урок успели перекодировать целиком (там лёгкие дорожки уже есть) —
    // свои сегменты поверх его не льём.
    const beforeUpload = await store.get(lesson.hlsPath);
    if (!beforeUpload) throw new Error("master.m3u8 пропал во время кодирования");
    const stillMissing = missingVariants(
      beforeUpload.toString("utf8"),
      plan.missing.map((r) => r.name),
    );
    if (stillMissing.length !== plan.missing.length)
      throw new Error("дорожки появились в master, пока кодировали — урок перекодирован заново");

    // Заливка: сегменты, потом плейлист дорожки. Дорожки ещё нет в master,
    // поэтому перезапись после прошлого обрыва никому не мешает.
    let uploaded = 0;
    for (const r of plan.missing) {
      const dir = path.join(outDir, r.name);
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
      for (const f of files) {
        await store.put(`${prefix}/${r.name}/${f}`, await fs.promises.readFile(path.join(dir, f)), "video/mp2t");
        uploaded += 1;
      }
      await store.put(
        `${prefix}/${r.name}/index.m3u8`,
        await fs.promises.readFile(path.join(dir, "index.m3u8")),
        M3U8,
        MANIFEST_CACHE,
      );
      uploaded += 1;
    }

    // master — ПОСЛЕДНИМ и по свежей копии: вдруг его успели поменять.
    const stale2 = opts.recheck ? await opts.recheck() : null;
    if (stale2) throw new Error(`урок изменился во время заливки: ${stale2}`);
    const freshBuf = await store.get(lesson.hlsPath);
    if (!freshBuf) throw new Error("master.m3u8 пропал во время работы");
    const fresh = freshBuf.toString("utf8");
    const merged = mergeMaster(fresh, addedMaster);
    const added = missingVariants(
      fresh,
      plan.missing.map((r) => r.name),
    );
    if (merged !== fresh) {
      await store.put(lesson.hlsPath, Buffer.from(merged, "utf8"), M3U8, MANIFEST_CACHE);
      uploaded += 1;
    }
    return { added, uploaded, source: plan.from };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
