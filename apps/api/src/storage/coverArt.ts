import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";

/**
 * ОБЛОЖКИ УРОКОВ — генерируются автоматически из кадра видео.
 *
 * Два формата из одного кадра:
 *   • renderLessonCover  — 1280×720 (16:9) для списков, панели, og:image;
 *   • renderStoryCover   — 1080×1920 (9:16) для «геройского» экрана урока и
 *                          шаринга в Instagram Stories / WhatsApp-статус.
 *
 * Слои: кадр (cover-fit, кроп по «интересной» области) → малиновый градиент
 * бренда (#c9376b → прозрачный) → крупный номер урока → название (до двух
 * строк, размер уменьшается, пока не влезет) → пилюля «N мин» → мелкий
 * вордмарк SHIRIN SWEETS. Цвет текста — кремовый, как на карточках рецептов.
 *
 * ПОЧЕМУ ТЕКСТ РИСУЕТ CANVAS, А НЕ SVG. Sharp растеризует SVG через librsvg,
 * а тот игнорирует @font-face с data-URI и берёт шрифт из fontconfig системы.
 * Проверено: текст с встроенным Noto Sans вышел в Times. На VPS без
 * кириллических шрифтов таджикские ӣӯҳқҷғ превратились бы в квадраты. Поэтому
 * типографику рисуем через @napi-rs/canvas с Noto Sans из assets/fonts — тем же
 * путём, что сертификат (src/course/certificate.ts): шрифт всегда с нами,
 * системные не нужны. Sharp делает то, в чём он лучший: cover-fit, композит,
 * mozjpeg.
 *
 * Функции чистые: буфер на входе, буфер на выходе, без файлов и БД. Как
 * подключить после транскода — см. scratchpad/visual-ideas.md (постер-кадр
 * из videoPipeline → renderLessonCover → S3 рядом с poster.jpg).
 */

export type CoverLang = "ru" | "tg";

export type CoverInput = {
  /** JPEG/PNG кадр — постер из транскода или кадр тизера. Любого размера. */
  frame: Buffer;
  /** Порядковый номер урока в курсе (1-based). */
  number: number;
  title: string;
  durationMin: number;
  lang: CoverLang;
};

export type CoverSize = { width: number; height: number };

export const LESSON_COVER: CoverSize = { width: 1280, height: 720 };
export const STORY_COVER: CoverSize = { width: 1080, height: 1920 };

/** Цвета — из токенов course.css: --c-accent и кремовый текст карточек. */
const BRAND = {
  raspberry: { r: 201, g: 55, b: 107 }, // #c9376b
  cream: "#fff6f0",
  creamMuted: "rgba(255, 246, 240, 0.78)",
  ink: "rgba(23, 24, 28, 0.55)",
} as const;

const FONT_FAMILY = "Sweet School Sans";
const FONT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts", "NotoSans-Regular.ttf");
let fontRegistered = false;

function ensureFont(): void {
  if (fontRegistered) return;
  GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
  fontRegistered = true;
}

const DURATION_UNIT: Record<CoverLang, string> = { ru: "мин", tg: "дақ." };

function rgba(a: number): string {
  const { r, g, b } = BRAND.raspberry;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Все размеры раскладки — доли от короткой стороны, чтобы 16:9 и 9:16 были родственниками. */
type Layout = {
  pad: number;
  numberSize: number;
  titleMax: number;
  titleMin: number;
  titleWidth: number;
  pillSize: number;
  markSize: number;
};

function layoutFor(size: CoverSize): Layout {
  const short = Math.min(size.width, size.height);
  const portrait = size.height > size.width;
  return {
    pad: Math.round(short * 0.065),
    numberSize: Math.round(short * (portrait ? 0.3 : 0.34)),
    titleMax: Math.round(short * (portrait ? 0.085 : 0.095)),
    titleMin: Math.round(short * 0.05),
    titleWidth: portrait ? size.width - Math.round(short * 0.13) : Math.round(size.width * 0.6),
    pillSize: Math.round(short * 0.038),
    markSize: Math.round(short * 0.026),
  };
}

function wrapWords(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Подбирает размер шрифта, при котором название помещается в две строки.
 * Если даже минимальный не помог (очень длинное слово) — обрезаем вторую
 * строку многоточием: на обложке важнее композиция, полное имя есть в списке.
 */
function fitTitle(ctx: SKRSContext2D, title: string, layout: Layout): { size: number; lines: string[] } {
  for (let size = layout.titleMax; size >= layout.titleMin; size -= 2) {
    ctx.font = `${size}px "${FONT_FAMILY}"`;
    const lines = wrapWords(ctx, title, layout.titleWidth);
    if (lines.length <= 2 && lines.every((l) => ctx.measureText(l).width <= layout.titleWidth)) {
      return { size, lines };
    }
  }
  ctx.font = `${layout.titleMin}px "${FONT_FAMILY}"`;
  const lines = wrapWords(ctx, title, layout.titleWidth).slice(0, 2);
  if (lines.length === 2) {
    let last = lines[1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > layout.titleWidth) last = last.slice(0, -1);
    lines[1] = `${last}…`;
  }
  return { size: layout.titleMin, lines };
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Noto Sans Regular один; «жирность» номера добиваем обводкой того же цвета. */
function boldText(ctx: SKRSContext2D, text: string, x: number, y: number, weight: number): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = weight;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Прозрачный PNG со всем, что лежит поверх кадра: градиент, номер, название, пилюля, вордмарк. */
function renderOverlay(input: CoverInput, size: CoverSize): Buffer {
  ensureFont();
  const { width, height } = size;
  const portrait = height > width;
  const L = layoutFor(size);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Градиент бренда: снизу — плотная малина, к верху — прозрачно. На 16:9
  // добавляем и горизонтальный, чтобы левая часть с текстом читалась на любом кадре.
  const vertical = ctx.createLinearGradient(0, height, 0, portrait ? height * 0.38 : height * 0.12);
  vertical.addColorStop(0, rgba(0.9));
  vertical.addColorStop(0.5, rgba(0.42));
  vertical.addColorStop(1, rgba(0));
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, width, height);
  if (!portrait) {
    const horizontal = ctx.createLinearGradient(0, 0, width * 0.62, 0);
    horizontal.addColorStop(0, rgba(0.42));
    horizontal.addColorStop(1, rgba(0));
    ctx.fillStyle = horizontal;
    ctx.fillRect(0, 0, width, height);
  }
  // Лёгкая тень сверху — чтобы вордмарк был виден и на светлых кадрах.
  const top = ctx.createLinearGradient(0, 0, 0, height * 0.18);
  top.addColorStop(0, BRAND.ink);
  top.addColorStop(1, "rgba(23, 24, 28, 0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, height);

  // Вордмарк — сверху слева, разрядка как на неоновой вывеске.
  ctx.fillStyle = BRAND.cream;
  ctx.font = `${L.markSize}px "${FONT_FAMILY}"`;
  ctx.letterSpacing = `${Math.round(L.markSize * 0.32)}px`;
  ctx.textBaseline = "top";
  ctx.fillText("SHIRIN SWEETS", L.pad, L.pad);
  ctx.letterSpacing = "0px";

  // Снизу вверх: пилюля → название → номер. Так блок всегда прижат к низу.
  ctx.textBaseline = "alphabetic";
  let cursorY = height - L.pad;

  const unit = DURATION_UNIT[input.lang];
  const pillText = `${Math.max(1, Math.round(input.durationMin))} ${unit}`;
  ctx.font = `${L.pillSize}px "${FONT_FAMILY}"`;
  const pillPadX = Math.round(L.pillSize * 0.7);
  const pillH = Math.round(L.pillSize * 1.7);
  const pillW = Math.round(ctx.measureText(pillText).width) + pillPadX * 2;
  const pillY = cursorY - pillH;
  ctx.fillStyle = "rgba(255, 246, 240, 0.22)";
  roundRect(ctx, L.pad, pillY, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 246, 240, 0.55)";
  ctx.lineWidth = Math.max(1, Math.round(L.pillSize * 0.06));
  ctx.stroke();
  ctx.fillStyle = BRAND.cream;
  ctx.fillText(pillText, L.pad + pillPadX, pillY + pillH * 0.68);
  cursorY = pillY - Math.round(L.pillSize * 0.9);

  const { size: titleSize, lines } = fitTitle(ctx, input.title, L);
  const lineH = Math.round(titleSize * 1.18);
  ctx.font = `${titleSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle = BRAND.cream;
  for (let i = lines.length - 1; i >= 0; i--) {
    boldText(ctx, lines[i], L.pad, cursorY, Math.max(1, titleSize * 0.03));
    cursorY -= lineH;
  }
  cursorY -= Math.round(titleSize * 0.15);

  const numberText = String(input.number).padStart(2, "0");
  ctx.font = `${L.numberSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle = BRAND.cream;
  boldText(ctx, numberText, L.pad - Math.round(L.numberSize * 0.04), cursorY, L.numberSize * 0.05);

  // Подпись «урок» справа от номера — тихо, приглушённым кремом.
  const label = input.lang === "tg" ? "ДАРСИ" : "УРОК";
  const numberW = ctx.measureText(numberText).width;
  ctx.font = `${L.pillSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle = BRAND.creamMuted;
  ctx.letterSpacing = `${Math.round(L.pillSize * 0.25)}px`;
  ctx.fillText(label, L.pad + numberW + Math.round(L.pillSize * 0.8), cursorY - Math.round(L.numberSize * 0.62));
  ctx.letterSpacing = "0px";

  return canvas.toBuffer("image/png");
}

async function renderCover(input: CoverInput, size: CoverSize): Promise<Buffer> {
  const overlay = renderOverlay(input, size);
  return sharp(input.frame)
    .rotate() // уважаем EXIF-ориентацию телефонных кадров
    .resize(size.width, size.height, { fit: "cover", position: sharp.strategy.attention, kernel: "lanczos3" })
    .composite([{ input: overlay, blend: "over" }])
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/** Обложка 1280×720 для списков уроков, панели и превью ссылок. */
export function renderLessonCover(input: CoverInput): Promise<Buffer> {
  return renderCover(input, LESSON_COVER);
}

/** Вертикальная обложка 1080×1920 для экрана урока и шаринга в сторис/WhatsApp. */
export function renderStoryCover(input: CoverInput): Promise<Buffer> {
  return renderCover(input, STORY_COVER);
}
