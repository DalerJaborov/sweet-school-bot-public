/**
 * ФОТО-КОНВЕЙЕР САЙТА — единая «студийная» обработка настоящих фото десертов
 * и инструментов Ширин (снято на телефон, свет и кадрирование разные).
 *
 *   node scripts/enhance-images.mjs [--force] [--only desserts|tools]
 *
 * Источники:  site-content/media-src/<группа>/<имя>.{jpg,png,webp}
 *             Это самые крупные из имеющихся файлов: оригиналы из экспорта
 *             Telegram — 720×1280 JPEG, те же кадры, из которых были нарезаны
 *             первые webp 800×1000. Положите сюда оригинал получше — с тем же
 *             имением файла — и всё пересоберётся само.
 * Результат:  public/img/<группа>/<имя>.webp       (полный размер)
 *             public/img/<группа>/<имя>-sm.webp    (половина, для srcset)
 *             public/img/<группа>/<имя>.avif, <имя>-sm.avif (та же пара)
 *             + обновлённые width/height/avif в site-content/media.json
 *             (записи находятся по basename в поле src — имена стабильны,
 *             страницы и тесты ничего не замечают).
 *
 * Что делает с каждым кадром, по порядку:
 *   1. rotate()             — EXIF-ориентация телефонных снимков;
 *   2. normalise 1–99 %     — авто-уровни: убирает серую пелену и тёмные кадры;
 *   3. modulate saturation  — +8 %, чтобы шоколад и ягоды не были блёклыми,
 *      но без «инстаграм-фильтра»;
 *   4. recomb               — лёгкое тепло в крем бренда (R×1.03, B×0.96);
 *   5. resize cover, attention — умный кроп в фиксированные пропорции:
 *      десерты 1:1 (плитка меню) — кроп по «интересной» области (attention);
 *      инструменты 4:3 (карточка «Что понадобится») — кроп к низу кадра, где
 *      лежит предмет (attention ловил бы неоновую вывеску над ним);
 *   6. sharpen              — мягкая нерезкая маска после ресайза;
 *   7. виньетка             — едва заметная (α≈0.10), собирает взгляд к центру
 *      и прячет пёстрый фон по краям.
 *
 * Ширины: полная = min(запрошенная, ширина источника) — не апскейлим 720-пикс.
 * кадр до 1600, честнее отдать 800 резко. Когда владелица пришлёт оригиналы
 * покрупнее, полная ширина вырастет сама (см. FULL_WIDTH).
 *
 * Идемпотентно: выход пересобирается только если источник или этот скрипт
 * новее любого из выходных файлов (или --force). Повторный запуск без
 * изменений ничего не пишет — ни файлов, ни media.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const WEB_ROOT = path.resolve(path.dirname(__filename), "..");
const SRC_ROOT = path.join(WEB_ROOT, "site-content", "media-src");
const OUT_ROOT = path.join(WEB_ROOT, "public", "img");
const MEDIA_JSON = path.join(WEB_ROOT, "site-content", "media.json");

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

/** Полная ширина по умолчанию; реальная = min(FULL_WIDTH, ширина источника). */
const FULL_WIDTH = 1600;
const WEBP = { quality: 80, effort: 5 };
const AVIF = { quality: 55, effort: 5 };

/** Группы: пропорция кадра и ключ в media.json. */
const GROUPS = {
  desserts: { aspect: [1, 1], position: sharp.strategy.attention },
  // Кадры из 10 видеоуроков «Арт-десертов» (программа курса), плитка 1:1.
  art: { aspect: [1, 1], position: sharp.strategy.attention },
  // Инструменты сняты у неоновой вывески: «интересная область» для attention —
  // сама вывеска, а предмет всегда внизу кадра. Поэтому кроп прижат к низу.
  tools: { aspect: [4, 3], position: "south" },
  // Широкие фото-фоны для героя лендинга курса (heroBold) — десерт снят с
  // пустым полем сверху под заголовок, поэтому кроп 16:9 по attention:
  // «интересная область» (сам десерт) внизу кадра остаётся целиком.
  hero: { aspect: [16, 9], position: sharp.strategy.attention },
};

const SUPPORTED = /\.(jpe?g|png|webp|avif|tiff?)$/i;

/** SVG-виньетка: прозрачный центр, лёгкое затемнение к углам. */
function vignette(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="72%">
      <stop offset="60%" stop-color="#2b1d1f" stop-opacity="0"/>
      <stop offset="100%" stop-color="#2b1d1f" stop-opacity="0.10"/>
    </radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return Buffer.from(svg);
}

/**
 * Явный квадратный кроп для вертикальных кадров из видеоуроков (720×1280):
 * доля высоты кадра, на которой лежит ЦЕНТР десерта. Так десерт всегда в центре
 * плитки, а водяной знак генератора в нижнем углу и пустой пол в кадр не попадают.
 * Остальные источники (уже квадратные/4:5) режутся по attention как раньше.
 */
const CROP_CENTER_Y = {
  "afganskaya-pahlava": 0.46,
  "anna-pavlova": 0.45,
  "bananovoe-pirozhnoe": 0.7,
  "chizkejk-tviks": 0.6,
  ekler: 0.47,
  "pirozhnoe-oreo": 0.55,
  "rulet-merenga": 0.52,
  "tort-karamelnyj": 0.56,
  "tvorozhnyj-pirog": 0.53,
};

/** Цели единой «студийной» картинки: средняя яркость, насыщенность, белые. */
const TARGET_LUMA = 0.5;
const TARGET_SAT = 0.4;
const WARM = [1.03, 1.0, 0.95];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Замер кадра по маленькой копии: яркость, насыщенность, цвет «белых» (тарелка, доска). */
async function measure(buf) {
  const { data } = await sharp(buf).resize(96, 96, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let luma = 0, sat = 0, n = 0, hr = 0, hg = 0, hb = 0, hn = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma += y; sat += mx === 0 ? 0 : (mx - mn) / mx; n++;
    if (y > 0.72 && mx - mn < 0.18) { hr += r; hg += g; hb += b; hn++; }
  }
  return { luma: luma / n, sat: sat / n, white: hn > n * 0.03 ? [hr / hn, hg / hn, hb / hn] : null };
}

/**
 * Базовая коррекция до ресайза — одна для всех выходных размеров.
 * Адаптивная: каждый кадр подтягивается к общей цели, поэтому все 21 десерт
 * выглядят однородно, а тёмный/зелёный/блёклый кадр не требует ручной подгонки.
 *   1. rotate + кроп (см. CROP_CENTER_Y);
 *   2. баланс белого по тарелке/доске (на 70 %), затем тёплый сдвиг бренда;
 *   3. авто-уровни 1–99 %;
 *   4. гамма по яркости кадра (светлее тёмные, не выжигая светлые);
 *   5. насыщенность к цели 0.40, с пределами 0.95–1.28 (фисташковый уже яркий);
 *   (CLAHE пробовал — на сжатых видеокадрах даёт грязные артефакты, не использовать.)
 */
async function grade(srcFile, name) {
  const { data: rotated, info } = await sharp(srcFile).rotate().toBuffer({ resolveWithObject: true });
  let buf = rotated;
  const cy = CROP_CENTER_Y[name];
  if (cy !== undefined && info.height > info.width) {
    const top = clamp(Math.round(cy * info.height - info.width / 2), 0, info.height - info.width);
    buf = await sharp(rotated).extract({ left: 0, top, width: info.width, height: info.width }).toBuffer();
  }
  const m = await measure(buf);
  const wb = m.white
    ? [clamp(m.white[1] / m.white[0], 0.9, 1.12), 1, clamp(m.white[1] / m.white[2], 0.9, 1.12)].map((g) => 1 + (g - 1) * 0.7)
    : [1, 1, 1];
  const gamma = clamp(Math.log(TARGET_LUMA) / Math.log(clamp(m.luma, 0.2, 0.8)), 1.0, 1.6);
  const saturation = clamp(TARGET_SAT / Math.max(m.sat, 0.05), 0.95, 1.28);
  return sharp(buf)
    .recomb([
      [wb[0] * WARM[0], 0, 0],
      [0, wb[1] * WARM[1], 0],
      [0, 0, wb[2] * WARM[2]],
    ])
    .normalise({ lower: 1, upper: 99 })
    .gamma(gamma)
    .modulate({ saturation });
}

async function renderVariant(graded, width, height, position) {
  const base = await graded
    .clone()
    .resize(width, height, { fit: "cover", position, kernel: "lanczos3" })
    .sharpen({ sigma: 1.0, m1: 0.8, m2: 0.5 })
    .toBuffer();
  return sharp(base).composite([{ input: vignette(width, height), blend: "over" }]);
}

function outputsFor(group, name) {
  const dir = path.join(OUT_ROOT, group);
  return {
    full: { webp: path.join(dir, `${name}.webp`), avif: path.join(dir, `${name}.avif`) },
    sm: { webp: path.join(dir, `${name}-sm.webp`), avif: path.join(dir, `${name}-sm.avif`) },
  };
}

function isFresh(srcFile, outs) {
  if (force) return false;
  const stamp = Math.max(fs.statSync(srcFile).mtimeMs, fs.statSync(__filename).mtimeMs);
  return [outs.full.webp, outs.full.avif, outs.sm.webp, outs.sm.avif].every(
    (f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > stamp,
  );
}

/** @returns {Promise<{name, width, height, changed}>} */
async function processOne(group, srcFile) {
  const name = path.basename(srcFile).replace(SUPPORTED, "");
  const { aspect, position } = GROUPS[group];
  const meta = await sharp(srcFile).rotate().metadata();
  const srcW = meta.width ?? FULL_WIDTH;
  const fullW = Math.min(FULL_WIDTH, srcW);
  const fullH = Math.round((fullW * aspect[1]) / aspect[0]);
  const smW = Math.round(fullW / 2);
  const smH = Math.round((smW * aspect[1]) / aspect[0]);
  const outs = outputsFor(group, name);
  if (isFresh(srcFile, outs)) return { name, width: fullW, height: fullH, changed: false };

  fs.mkdirSync(path.dirname(outs.full.webp), { recursive: true });
  const graded = await grade(srcFile, name);
  const full = await renderVariant(graded, fullW, fullH, position);
  const sm = await renderVariant(graded, smW, smH, position);
  await Promise.all([
    full.clone().webp(WEBP).toFile(outs.full.webp),
    full.clone().avif(AVIF).toFile(outs.full.avif),
    sm.clone().webp(WEBP).toFile(outs.sm.webp),
    sm.clone().avif(AVIF).toFile(outs.sm.avif),
  ]);
  return { name, width: fullW, height: fullH, changed: true };
}

/** Дописать width/height/avif в записи media.json, найденные по basename src. */
function updateMediaJson(results) {
  const media = JSON.parse(fs.readFileSync(MEDIA_JSON, "utf8"));
  let touched = 0;
  const byName = new Map();
  for (const [group, list] of Object.entries(results)) for (const r of list) byName.set(`${group}/${r.name}`, r);
  const patch = (entry) => {
    if (!entry?.src) return;
    const m = entry.src.match(/^\/img\/([^/]+)\/([^/]+)\.webp$/);
    if (!m) return;
    const r = byName.get(`${m[1]}/${m[2]}`);
    if (!r) return;
    const next = {
      ...entry,
      srcSm: `/img/${m[1]}/${m[2]}-sm.webp`,
      avif: `/img/${m[1]}/${m[2]}.avif`,
      avifSm: `/img/${m[1]}/${m[2]}-sm.avif`,
      width: r.width,
      height: r.height,
    };
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      Object.assign(entry, next);
      touched++;
    }
  };
  for (const entry of Object.values(media.desserts ?? {})) patch(entry);
  for (const entry of Object.values(media.artLessons ?? {})) patch(entry);
  for (const entry of media.tools ?? []) patch(entry);
  for (const entry of Object.values(media.heroPages ?? {})) patch(entry);
  if (touched > 0) fs.writeFileSync(MEDIA_JSON, `${JSON.stringify(media, null, 2)}\n`, "utf8");
  return touched;
}

async function main() {
  const results = {};
  let changed = 0;
  for (const group of Object.keys(GROUPS)) {
    if (only && only !== group) continue;
    const dir = path.join(SRC_ROOT, group);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => SUPPORTED.test(f))
      .sort();
    results[group] = [];
    for (const f of files) {
      const r = await processOne(group, path.join(dir, f));
      results[group].push(r);
      if (r.changed) {
        changed++;
        console.log(`  ${group}/${r.name}  ${r.width}×${r.height}`);
      }
    }
  }
  const touched = updateMediaJson(results);
  const total = Object.values(results).reduce((n, l) => n + l.length, 0);
  console.log(`images: ${total} sources, ${changed} rebuilt, media.json: ${touched} entries updated`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
