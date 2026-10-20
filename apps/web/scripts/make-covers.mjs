/**
 * ДИЗАЙНЕРСКИЕ ОБЛОЖКИ САЙТА — собираются из настоящих фото десертов Ширин
 * (никаких сгенерированных десертов: ученицы учатся готовить именно это).
 *
 *   node scripts/make-covers.mjs [--force]
 *
 * Что рисует (всё в public/img/covers/):
 *   • hero.webp / hero-sm.webp / hero.avif / hero-sm.avif — герой главной,
 *     1000×1250 (4:5, как слот .hero-photo): коллаж из трёх лучших десертов
 *     в скруглённых рамках с мягкими тенями на кремовом фоне;
 *   • course-<код>.webp (1600×900) и course-<код>-og.jpg (1200×630) —
 *     обложки онлайн-курсов «Арт-десерты» и «21 рецепт»: заголовок слева,
 *     фото в рамке справа. Сайт подставляет их, пока в панели у курса нет
 *     своей (CoursesIsland → FALLBACK_COVER);
 *   • og-<slug|home>-<lang>.jpg (1200×630) — превью ссылки для каждой
 *     SEO-страницы на каждом языке: заголовок страницы + одно фото.
 * Пути к готовым файлам записываются в site-content/media.json (ключи hero,
 * ogPages, courseCovers) — build-site-pages и остров курсов читают их оттуда.
 *
 * Стиль — тот же, что у обложек уроков в apps/api/src/storage/coverArt.ts:
 * крем #fff8f3, малина #c9376b, скруглённые рамки, вордмарк SHIRIN SWEETS с
 * разрядкой. Типографику рисует @napi-rs/canvas (а не SVG через librsvg — тот
 * игнорирует @font-face, см. пояснение в coverArt.ts). Шрифт — Noto Sans из
 * apps/api/assets/fonts: единственный шрифт с кириллицей и таджикскими
 * буквами ӣӯҳқҷғ, который лежит в репозитории; «жирность» добиваем обводкой.
 * Onest/Montserrat в репозитории нет, а тянуть шрифт из сети в скрипте сборки
 * значит зависеть от сети — положите TTF в FONT_CANDIDATES, и он подхватится.
 *
 * Идемпотентно: перерисовывает, только если фото-источник, media.json-текст
 * страниц или сам скрипт новее выходных файлов (или --force).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { loadContent } from "./build-site-pages.mjs";

const __filename = fileURLToPath(import.meta.url);
const WEB_ROOT = path.resolve(path.dirname(__filename), "..");
const PUBLIC = path.join(WEB_ROOT, "public");
const OUT_DIR = path.join(PUBLIC, "img", "covers");
const MEDIA_JSON = path.join(WEB_ROOT, "site-content", "media.json");
const force = process.argv.includes("--force");

// ---------- шрифт ----------

const FONT_FAMILY = "Shirin Cover Sans";
const FONT_CANDIDATES = [
  path.join(WEB_ROOT, "assets", "fonts", "Onest-ExtraBold.ttf"),
  path.join(WEB_ROOT, "assets", "fonts", "Montserrat-ExtraBold.ttf"),
  path.join(WEB_ROOT, "..", "api", "assets", "fonts", "NotoSans-Regular.ttf"),
];
const fontPath = FONT_CANDIDATES.find((f) => fs.existsSync(f));
if (!fontPath) {
  console.error("Шрифт не найден, проверьте FONT_CANDIDATES в make-covers.mjs");
  process.exit(1);
}
GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
/** Noto Sans Regular — один вес; «800» имитируем обводкой (как в coverArt.ts). */
const FAUX_BOLD = /NotoSans/.test(fontPath);

// ---------- палитра ----------

const C = {
  cream: "#fff8f3",
  creamDeep: "#fbe8ef",
  ink: "#2b1d1f",
  muted: "#7a6b6c",
  raspberry: "#c9376b",
  raspberry2: "#e8628f",
  gold: "#c9a227",
  white: "#ffffff",
};

// ---------- утилиты canvas ----------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, str, x, y, { size, color, weight = 0, spacing = 0, align = "left" }) {
  ctx.font = `${size}px "${FONT_FAMILY}"`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${spacing}px`;
  if (FAUX_BOLD && weight > 0) {
    ctx.lineJoin = "round";
    ctx.lineWidth = size * weight;
    ctx.strokeStyle = color;
    ctx.strokeText(str, x, y);
  }
  ctx.fillText(str, x, y);
  ctx.letterSpacing = "0px";
}

function wrapWords(ctx, str, size, maxWidth) {
  ctx.font = `${size}px "${FONT_FAMILY}"`;
  const words = str.trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (ctx.measureText(cand).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = cand;
  }
  if (line) lines.push(line);
  return lines;
}

/** Подбор размера: уменьшаем, пока заголовок не влезет в maxLines строк. */
function fitTitle(ctx, str, { max, min, width, maxLines }) {
  for (let size = max; size >= min; size -= 2) {
    const lines = wrapWords(ctx, str, size, width);
    if (lines.length <= maxLines) return { size, lines };
  }
  const lines = wrapWords(ctx, str, min, width).slice(0, maxLines);
  const last = lines[lines.length - 1];
  if (last && wrapWords(ctx, str, min, width).length > maxLines)
    lines[lines.length - 1] = `${last.replace(/\s*\S*$/, "")}…`;
  return { size: min, lines };
}

/** Кремовый фон с мягкими малиновыми пятнами по углам — «дыхание» вместо плоской заливки. */
function paintBackground(ctx, w, h) {
  ctx.fillStyle = C.cream;
  ctx.fillRect(0, 0, w, h);
  const blob = (cx, cy, r, alpha) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(232, 98, 143, ${alpha})`);
    g.addColorStop(1, "rgba(232, 98, 143, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  blob(w * 0.92, h * 0.05, Math.min(w, h) * 0.55, 0.28);
  blob(w * 0.08, h * 1.0, Math.min(w, h) * 0.6, 0.18);
}

function wordmark(ctx, x, y, size, color = C.raspberry) {
  text(ctx, "SHIRIN SWEETS", x, y, { size, color, weight: 0.05, spacing: Math.round(size * 0.32) });
}

/** Фото в скруглённой рамке с мягкой тенью; кроп cover по «интересной» области — заранее, в sharp. */
async function photoFrame(ctx, file, x, y, w, h, r, { rotate = 0, shadow = 0.22 } = {}) {
  const buf = await sharp(file)
    .rotate()
    .resize(Math.round(w), Math.round(h), { fit: "cover", position: sharp.strategy.attention })
    .png()
    .toBuffer();
  const img = await loadImage(buf);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.shadowColor = `rgba(43, 29, 31, ${shadow})`;
  ctx.shadowBlur = Math.round(h * 0.12);
  ctx.shadowOffsetY = Math.round(h * 0.05);
  ctx.fillStyle = C.white;
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.clip();
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function chip(ctx, label, x, y, size, { fill = C.creamDeep, color = C.raspberry } = {}) {
  ctx.font = `${size}px "${FONT_FAMILY}"`;
  const padX = Math.round(size * 0.9);
  const h = Math.round(size * 2);
  const w = Math.round(ctx.measureText(label).width) + padX * 2;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  text(ctx, label, x + padX, y + h * 0.68, { size, color, weight: 0.03 });
  return w;
}

// ---------- композиции ----------

/** Герой главной: три фото каскадом на кремовом, 4:5. */
async function renderHero(photos, W = 1000, H = 1250) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, W, H);
  // Задний кадр — крупный торт, два передних — поменьше, с лёгким наклоном.
  await photoFrame(ctx, photos[0], W * 0.16, H * 0.06, W * 0.7, H * 0.5, 44, { rotate: -3, shadow: 0.18 });
  await photoFrame(ctx, photos[1], W * 0.06, H * 0.45, W * 0.5, H * 0.36, 40, { rotate: 4 });
  await photoFrame(ctx, photos[2], W * 0.5, H * 0.53, W * 0.44, H * 0.32, 40, { rotate: -5 });
  wordmark(ctx, W * 0.08, H * 0.955, 26);
  return canvas;
}

/** Обложка курса: текст слева, фото справа; общая для 16:9 и 1200×630. */
async function renderCourseCover({ title, eyebrow, chips, photo }, W, H) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, W, H);
  const pad = Math.round(H * 0.09);
  const photoW = Math.round(W * 0.4);
  const photoH = Math.round(H - pad * 2);
  await photoFrame(ctx, photo, W - pad - photoW, pad, photoW, photoH, Math.round(H * 0.06), { rotate: -2 });

  const textW = W - pad * 3 - photoW;
  wordmark(ctx, pad, pad + 18, Math.round(H * 0.03));
  text(ctx, eyebrow.toUpperCase(), pad, pad + Math.round(H * 0.12), {
    size: Math.round(H * 0.034),
    color: C.muted,
    weight: 0.02,
    spacing: 2,
  });
  const { size, lines } = fitTitle(ctx, title, {
    max: Math.round(H * 0.14),
    min: Math.round(H * 0.07),
    width: textW,
    maxLines: 3,
  });
  let y = pad + Math.round(H * 0.2) + size;
  for (const line of lines) {
    text(ctx, line, pad, y, { size, color: C.ink, weight: 0.055 });
    y += Math.round(size * 1.12);
  }
  let cx = pad;
  const chipSize = Math.round(H * 0.032);
  for (const label of chips) cx += chip(ctx, label, cx, H - pad - chipSize * 2, chipSize) + Math.round(chipSize * 0.6);
  return canvas;
}

/** OG страницы: заголовок страницы + фото. Та же раскладка, ярче акценты. */
async function renderPageOg({ title, eyebrow, photo, brand }, W = 1200, H = 630) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  paintBackground(ctx, W, H);
  const pad = 60;
  const photoW = 420;
  await photoFrame(ctx, photo, W - pad - photoW, pad, photoW, H - pad * 2, 36, { rotate: 2 });
  wordmark(ctx, pad, pad + 18, 20);
  text(ctx, eyebrow.toUpperCase(), pad, pad + 70, { size: 20, color: C.raspberry, weight: 0.02, spacing: 2 });
  const textW = W - pad * 3 - photoW;
  const { size, lines } = fitTitle(ctx, title, { max: 62, min: 36, width: textW, maxLines: 4 });
  let y = pad + 110 + size;
  for (const line of lines) {
    text(ctx, line, pad, y, { size, color: C.ink, weight: 0.055 });
    y += Math.round(size * 1.12);
  }
  text(ctx, brand, pad, H - pad, { size: 22, color: C.muted });
  return canvas;
}

// ---------- запись ----------

async function writeWebpSet(canvas, base) {
  const png = canvas.toBuffer("image/png");
  const full = sharp(png);
  const half = sharp(png).resize(Math.round(canvas.width / 2));
  await Promise.all([
    full.clone().webp({ quality: 82 }).toFile(`${base}.webp`),
    full.clone().avif({ quality: 58 }).toFile(`${base}.avif`),
    half.clone().webp({ quality: 82 }).toFile(`${base}-sm.webp`),
    half.clone().avif({ quality: 58 }).toFile(`${base}-sm.avif`),
  ]);
}

async function writeJpeg(canvas, file) {
  await sharp(canvas.toBuffer("image/png")).jpeg({ quality: 84, mozjpeg: true }).toFile(file);
}

/** Пересобирать ли: любой выход старше источников/скрипта — да. */
function stale(outputs, inputs) {
  if (force) return true;
  if (!outputs.every((f) => fs.existsSync(f))) return true;
  const newest = Math.max(...inputs.map((f) => fs.statSync(f).mtimeMs), fs.statSync(__filename).mtimeMs);
  return outputs.some((f) => fs.statSync(f).mtimeMs <= newest);
}

const pub = (abs) => `/${path.relative(PUBLIC, abs).split(path.sep).join("/")}`;
const dessertFile = (media, ruName) => path.join(PUBLIC, media.desserts[ruName].src);

/** Какое фото иллюстрирует страницу в превью ссылки (ключ — slug, "" — главная). */
const PAGE_PHOTO = {
  "": "Шоколадный торт",
  "online-kurs": "Пирожное «Красный бархат»",
  "art-desserty": "Пирожное «Рафаэлло»",
  "kursy-konditera-dushanbe": "Пирожное «Сникерс»",
  sertifikat: "Пирожное «Шу»",
  otzyvy: "Пирожное «Вупи пай»",
  faq: "Пирожное «Рафаэлло»",
  "o-shirin": null, // иллюстрация Ширин
  "politika-konfidentsialnosti": "Чизкейк-тортики",
};

const HERO_PHOTOS = ["Шоколадный торт", "Пирожное «Красный бархат»", "Пирожное «Шу»"];

const COURSES = [
  {
    code: "COURSE50",
    title: { ru: "Арт-десерты", tg: "Арт-десертҳо" },
    eyebrow: { ru: "Онлайн-курс Ширин", tg: "Курси онлайнии Ширин" },
    chips: { ru: ["видеоуроки", "сертификат", "доступ навсегда"], tg: ["видеодарсҳо", "сертификат", "дастрасӣ абадӣ"] },
    photo: path.join(PUBLIC, "img", "desserts", "art-desert-cover.webp"),
  },
  {
    code: "COURSE70",
    title: { ru: "21 рецепт", tg: "21 ретсепт" },
    eyebrow: { ru: "Онлайн-курс Ширин", tg: "Курси онлайнии Ширин" },
    chips: {
      ru: ["21 видеоурок", "сертификат", "доступ навсегда"],
      tg: ["21 видеодарс", "сертификат", "дастрасӣ абадӣ"],
    },
    photo: null, // Пирожное «Красный бархат» — см. ниже, путь берётся из media.json
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { site, pages, media } = loadContent();
  if (!media?.desserts) throw new Error("site-content/media.json без desserts — нечего собирать");
  const pagesDir = path.join(WEB_ROOT, "site-content", "pages");
  const pageFiles = fs.readdirSync(pagesDir).map((f) => path.join(pagesDir, f));
  let rendered = 0;

  // Герой главной.
  const heroInputs = HERO_PHOTOS.map((n) => dessertFile(media, n));
  const heroBase = path.join(OUT_DIR, "hero");
  const heroOuts = [".webp", ".avif", "-sm.webp", "-sm.avif"].map((s) => heroBase + s);
  if (stale(heroOuts, heroInputs)) {
    await writeWebpSet(await renderHero(heroInputs), heroBase);
    rendered++;
    console.log("  covers/hero 1000×1250");
  }
  media.hero = {
    src: pub(`${heroBase}.webp`),
    srcSm: pub(`${heroBase}-sm.webp`),
    avif: pub(`${heroBase}.avif`),
    avifSm: pub(`${heroBase}-sm.avif`),
    width: 1000,
    height: 1250,
    alt: {
      ru: `${HERO_PHOTOS.join(", ").replace(/«|»/g, "")} — десерты курса Shirin Sweets`,
      tg: `${HERO_PHOTOS.join(", ").replace(/«|»/g, "")} — шириниҳои курси Shirin Sweets`,
    },
  };

  // Обложки курсов (RU — на сайте карточки курсов показываются с названием из API,
  // язык обложки — русский, как и названия десертов по правилу владелицы).
  media.courseCovers = {};
  for (const c of COURSES) {
    const photo = c.photo ?? dessertFile(media, "Пирожное «Красный бархат»");
    const base = path.join(OUT_DIR, `course-${c.code.toLowerCase()}`);
    const outs = [`${base}.webp`, `${base}.avif`, `${base}-sm.webp`, `${base}-sm.avif`, `${base}-og.jpg`];
    if (stale(outs, [photo])) {
      const spec = { title: c.title.ru, eyebrow: c.eyebrow.ru, chips: c.chips.ru, photo };
      await writeWebpSet(await renderCourseCover(spec, 1600, 900), base);
      await writeJpeg(await renderCourseCover(spec, 1200, 630), `${base}-og.jpg`);
      rendered++;
      console.log(`  covers/course-${c.code.toLowerCase()} 1600×900 + og 1200×630`);
    }
    media.courseCovers[c.code] = {
      src: pub(`${base}.webp`),
      srcSm: pub(`${base}-sm.webp`),
      avif: pub(`${base}.avif`),
      og: pub(`${base}-og.jpg`),
      width: 1600,
      height: 900,
    };
  }

  // OG каждой страницы × язык.
  media.ogPages = {};
  const shirin = path.join(PUBLIC, media.shirin?.png ?? "img/shirin.webp");
  for (const page of pages) {
    const key = page.slug || "home";
    const photoName = PAGE_PHOTO[page.slug] ?? null;
    const photo = photoName ? dessertFile(media, photoName) : shirin;
    media.ogPages[page.slug] = {};
    for (const lang of ["ru", "tg"]) {
      const file = path.join(OUT_DIR, `og-${key}-${lang}.jpg`);
      const pageFile = pageFiles.find((f) => path.basename(f, ".json") === (page.slug || "home"));
      if (stale([file], [photo, ...(pageFile ? [pageFile] : [])])) {
        const title = page.h1[lang] ?? page.h1.ru;
        const eyebrow = page.crumb?.[lang] ?? (lang === "tg" ? "Асосӣ" : "Главная");
        await writeJpeg(
          await renderPageOg({ title, eyebrow, photo, brand: `${site.brand} · shirinsweets.online` }),
          file,
        );
        rendered++;
        console.log(`  covers/og-${key}-${lang} 1200×630`);
      }
      media.ogPages[page.slug][lang] = pub(file);
    }
  }

  const before = fs.readFileSync(MEDIA_JSON, "utf8");
  const after = `${JSON.stringify(media, null, 2)}\n`;
  if (before !== after) fs.writeFileSync(MEDIA_JSON, after, "utf8");
  console.log(`covers: ${rendered} rendered, media.json ${before === after ? "unchanged" : "updated"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
