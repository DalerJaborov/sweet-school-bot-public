import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * ИСТОЧНИК B ФАЗЫ 3 («максимальное использование архива») — рисует карточку
 * «имитация переписки Telegram» из благодарности ученицы (QaMessage), а не
 * рендерит настоящий HTML/браузер: карточка простая (фон + пузырь + текст),
 * гонять ради неё Chromium на маленьком VPS — тратить память без пользы.
 *
 * ИМЯ НАРОЧНО ОБЩЕЕ («Ученица курса»), не настоящее. В QaMessage лежит только
 * telegramUserId (число), настоящего имени бот не хранит нигде — доставать
 * его через Telegram API ради одной подписи под скриншотом не стоит, а
 * публиковать имя ученицы без её отдельного согласия на карточку-отзыв —
 * лишний риск на пустом месте.
 */

const FONT_FAMILY = "Sweet School Sans";
const FONT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts", "NotoSans-Regular.ttf");
let fontRegistered = false;

function ensureFont(): void {
  if (fontRegistered) return;
  GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
  fontRegistered = true;
}

const CARD_WIDTH = 720;
const OUTER_PADDING = 32;
const BUBBLE_PADDING = 22;
const NAME_SIZE = 16;
const BODY_SIZE = 21;
const TIME_SIZE = 14;
const LINE_HEIGHT = 29;
const MAX_TEXT_WIDTH = CARD_WIDTH - OUTER_PADDING * 2 - BUBBLE_PADDING * 2 - 64; // 64 — место под аватар слева

const WALLPAPER = "#dbe4ea";
const BUBBLE = "#ffffff";
const NAME_COLOR = "#3a8ee6";
const BODY_COLOR = "#1c1c1e";
const TIME_COLOR = "#8e8e93";
const AVATAR_BG = "#5eb26b";

function wrapText(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
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

function roundRectPath(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, w: number, h: number, radii: [number, number, number, number]): void {
  const [tl, tr, br, bl] = radii;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** Рисует PNG-карточку «Ширин ответила ученице» и возвращает готовые байты.
 *  createdAt — время исходного сообщения в группе, для подписи-таймштампа. */
export function renderQaCard(text: string, createdAt: Date): Buffer {
  ensureFont();

  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = `${BODY_SIZE}px "${FONT_FAMILY}"`;
  const lines = wrapText(measureCtx, text, MAX_TEXT_WIDTH);

  const bubbleTextHeight = lines.length * LINE_HEIGHT;
  const bubbleHeight = NAME_SIZE + 12 + bubbleTextHeight + 8 + TIME_SIZE + BUBBLE_PADDING * 2;
  const cardHeight = OUTER_PADDING * 2 + bubbleHeight;

  const canvas = createCanvas(CARD_WIDTH, cardHeight);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = WALLPAPER;
  ctx.fillRect(0, 0, CARD_WIDTH, cardHeight);

  // Аватар — просто цветной кружок с инициалом, без реального фото ученицы.
  const avatarR = 22;
  const avatarCx = OUTER_PADDING + avatarR;
  const avatarCy = OUTER_PADDING + avatarR + 4;
  ctx.fillStyle = AVATAR_BG;
  ctx.beginPath();
  ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${20}px "${FONT_FAMILY}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("У", avatarCx, avatarCy + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Пузырь сообщения — тот же приём, что у входящих сообщений в Telegram:
  // сглаженные углы везде, кроме нижнего левого (у самого края аватара).
  const bubbleX = OUTER_PADDING + avatarR * 2 + 16;
  const bubbleY = OUTER_PADDING;
  const bubbleWidth = CARD_WIDTH - bubbleX - OUTER_PADDING;
  roundRectPath(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, [4, 18, 18, 18]);
  ctx.fillStyle = BUBBLE;
  ctx.fill();

  let cursorY = bubbleY + BUBBLE_PADDING + NAME_SIZE;
  ctx.fillStyle = NAME_COLOR;
  ctx.font = `bold ${NAME_SIZE}px "${FONT_FAMILY}"`;
  ctx.fillText("Ученица курса", bubbleX + BUBBLE_PADDING, cursorY);

  cursorY += 12 + BODY_SIZE * 0.8;
  ctx.fillStyle = BODY_COLOR;
  ctx.font = `${BODY_SIZE}px "${FONT_FAMILY}"`;
  for (const line of lines) {
    ctx.fillText(line, bubbleX + BUBBLE_PADDING, cursorY);
    cursorY += LINE_HEIGHT;
  }

  cursorY += 8;
  ctx.fillStyle = TIME_COLOR;
  ctx.font = `${TIME_SIZE}px "${FONT_FAMILY}"`;
  ctx.textAlign = "right";
  const time = createdAt.toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
  ctx.fillText(time, bubbleX + bubbleWidth - BUBBLE_PADDING, cursorY);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}
