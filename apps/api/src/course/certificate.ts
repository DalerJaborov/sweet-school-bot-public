import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";
import QRCode from "qrcode";
import { prisma } from "../db.js";
import { env } from "../env.js";

/**
 * СЕРТИФИКАТ О ПРОХОЖДЕНИИ КУРСА (владелец 03.09.2026).
 *
 * Ученица, досмотревшая все уроки курса, вводит имя и фамилию (ещё раз, даже
 * если они уже есть в профиле — на документе не должно быть опечатки), выбирает
 * язык и скачивает PDF. Ошиблась — исправляет имя и скачивает снова: запись
 * одна на курс, перевыпуск её обновляет, номер остаётся тем же.
 *
 * PDF собирается из шаблонов владельца (assets/certificates/ru.pdf и tg.pdf —
 * A4, 595×842 pt): поверх подчёркивания печатаем имя, справа внизу — дату.
 * Шрифт — Noto Sans из assets/fonts: у него есть все таджикские буквы
 * (ӣ ӯ ҳ қ ҷ ғ), а стандартные PDF-шрифты кириллицы не знают вовсе.
 *
 * Сертификат хранится записью, не файлом: PDF пересобирается за миллисекунды,
 * а хранить 10 МБ на каждую ученицу незачем.
 */

export type CertificateLanguage = "ru" | "tg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** В dist/ модуль лежит на одном уровне вложенности с src/ — assets рядом с apps/api. */
const ASSETS = path.resolve(HERE, "..", "..", "assets");

const TEMPLATE: Record<CertificateLanguage, string> = {
  ru: path.join(ASSETS, "certificates", "ru.pdf"),
  tg: path.join(ASSETS, "certificates", "tg.pdf"),
};
const FONT = path.join(ASSETS, "fonts", "NotoSans-Regular.ttf");

/**
 * Где печатать. Координаты PDF — от нижнего левого угла. Измерены по
 * шаблону: подчёркивание под именем — на высоте ~422 pt, строка «Сана/Дата»
 * начинается на x≈483, y≈189. Имя центрируем по странице.
 */
const LAYOUT = {
  nameBaselineY: 442,
  nameSize: 26,
  nameMaxWidth: 460,
  dateX: 490,
  dateY: 197,
  dateSize: 11,
};

const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_TG = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];

export function formatIssueDate(date: Date, lang: CertificateLanguage): string {
  const months = lang === "tg" ? MONTHS_TG : MONTHS_RU;
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** Все ли уроки курса досмотрены этой покупкой. Уроки без видео не считаем —
 *  их досмотреть нельзя, и они не должны блокировать сертификат. */
export async function courseCompleted(purchaseId: string, courseId: string): Promise<{ done: number; total: number }> {
  const lessons = await prisma.lesson.findMany({
    // Корзина: урок в ней сертификат не блокирует и не засчитывается.
    where: { module: { courseId }, status: "READY", deletedAt: null },
    select: { id: true },
  });
  if (lessons.length === 0) return { done: 0, total: 0 };
  const done = await prisma.progress.count({
    where: { purchaseId, lessonId: { in: lessons.map((l) => l.id) }, completedAt: { not: null } },
  });
  return { done, total: lessons.length };
}

let fontBytes: Buffer | null = null;
const templateCache = new Map<CertificateLanguage, Buffer>();

async function loadFont(): Promise<Buffer> {
  if (!fontBytes) fontBytes = await fs.promises.readFile(FONT);
  return fontBytes;
}
async function loadTemplate(lang: CertificateLanguage): Promise<Buffer> {
  let t = templateCache.get(lang);
  if (!t) {
    t = await fs.promises.readFile(TEMPLATE[lang]);
    templateCache.set(lang, t);
  }
  return t;
}

/** Собрать PDF: шаблон + имя + дата. Возвращает байты файла. */
export async function renderCertificate(input: {
  fullName: string;
  issuedAt: Date;
  lang: CertificateLanguage;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await loadTemplate(input.lang));
  doc.registerFontkit(fontkit);
  // subset: false — с урезанием этот шаблон терял глифы (проверено на пробном PDF);
  // цена — два мегабайта шрифта в файле, для документа «на всю жизнь» приемлемо.
  const font = await doc.embedFont(await loadFont(), { subset: false });
  const page = doc.getPage(0);
  const { width } = page.getSize();

  // Имя — по центру, с уменьшением кегля для очень длинных имён, чтобы не
  // вылезать за подчёркивание.
  let size = LAYOUT.nameSize;
  let textWidth = font.widthOfTextAtSize(input.fullName, size);
  while (textWidth > LAYOUT.nameMaxWidth && size > 14) {
    size -= 1;
    textWidth = font.widthOfTextAtSize(input.fullName, size);
  }
  page.drawText(input.fullName, {
    x: (width - textWidth) / 2,
    y: LAYOUT.nameBaselineY,
    size,
    font,
    color: rgb(0.11, 0.09, 0.09),
  });

  page.drawText(formatIssueDate(input.issuedAt, input.lang), {
    x: LAYOUT.dateX,
    y: LAYOUT.dateY,
    size: LAYOUT.dateSize,
    font,
    color: rgb(0.11, 0.09, 0.09),
  });

  doc.setTitle(input.lang === "tg" ? "Сертификат — Shirin Sweets" : "Сертификат — Shirin Sweets");
  doc.setProducer("Shirin Sweets");
  return doc.save();
}

/** Файл, который скачает ученица. Только латиница и цифры: телефоны и
 *  мессенджеры с кириллицей в имени файла ладят плохо, а номер сертификата
 *  опознаёт документ не хуже имени. */
export function certificateFileName(number: number, lang: CertificateLanguage): string {
  return `shirin-sweets-certificate-${lang}-${number}.pdf`;
}

/**
 * СЕРТИФИКАТ ДЛЯ ШАРИНГА — PNG 1080×1350, лента Instagram (визуальная
 * система 04.09.2026, scratchpad/visual-ideas.md §6).
 *
 * «Тем же canvas-путём, что PDF» — буквально это невозможно: pdf-lib не умеет
 * отдавать растр. Тот же ПУТЬ здесь означает тот же инструмент рисования
 * текста и тот же гарантированно таджикский шрифт — @napi-rs/canvas с Noto
 * Sans из assets/fonts, каким уже рисуются обложки уроков (см.
 * storage/coverArt.ts: sharp/librsvg молча теряют @font-face и берут шрифт
 * системы, поэтому текст рисует canvas).
 *
 * ПОРТРЕТ ШИРИН — ОТКЛОНЕНИЕ ОТ БУКВЫ ТЗ. Формулировка задачи просила «фото
 * Ширин из архива», но на сессии 03–04.09.2026 действует правило владельца:
 * в публичных материалах — только согласованная иллюстрация
 * (apps/web/public/img/shirin.webp), настоящее фото не публикуется нигде.
 * Сертификат — публичный документ (шарится в Instagram), поэтому здесь то же
 * правило, а не архивное фото. Иллюстрация скопирована в
 * assets/certificates/shirin-portrait.webp, чтобы api не читал файлы web —
 * apps/api и apps/web разворачиваются независимо, а свои assets/ уже
 * заведены под сертификаты (шаблоны PDF рядом).
 */

const PNG_PORTRAIT = path.join(ASSETS, "certificates", "shirin-portrait.webp");
/** Тот же .ttf, что и в PDF, но зарегистрирован под именем для canvas. */
const CANVAS_FONT = "Shirin Sweets Certificate Sans";

export const CERTIFICATE_PNG_SIZE = { width: 1080, height: 1350 } as const;

const PNG_COLOR = {
  cream: "#fff6f0",
  raspberry: "#c9376b",
  ink: "#211417",
  muted: "rgba(33, 20, 23, 0.62)",
} as const;

/** Название/дата используют один и тот же ярлык, что уже напечатан на PDF
 *  владельца (см. комментарий к LAYOUT выше: «строка «Сана/Дата»»). */
const DATE_LABEL: Record<CertificateLanguage, string> = { ru: "Дата", tg: "Сана" };

function ensureCanvasFont(): void {
  // has() — на случай, если модуль загрузили дважды (например, в тестах);
  // повторная регистрация того же алиаса не нужна и не должна падать.
  if (!GlobalFonts.has(CANVAS_FONT)) GlobalFonts.registerFromPath(FONT, CANVAS_FONT);
}

function roundRectPng(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Noto Sans Regular один — «жирность» добиваем обводкой того же цвета
 *  (тот же приём, что на обложках уроков). */
function boldTextPng(ctx: SKRSContext2D, text: string, x: number, y: number, weight: number): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = weight;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Уменьшает кегль, пока строка не влезет в maxWidth — как имя на PDF. */
function fitOneLine(ctx: SKRSContext2D, text: string, maxWidth: number, startSize: number, minSize: number): number {
  let size = startSize;
  ctx.font = `${size}px "${CANVAS_FONT}"`;
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = `${size}px "${CANVAS_FONT}"`;
  }
  return size;
}

/** Перенос по словам, не более maxLines строк — как заголовок на обложке урока. */
function wrapLinesPng(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** Адрес проверки для QR: тот же номер, что напечатан на документе. */
export function verificationUrl(number: number): string {
  const base = (env.publicBaseUrl || "https://shirinsweets.online").replace(/\/+$/, "");
  return `${base}/api/course/certificate/verify/${number}`;
}

/** Собрать PNG для шаринга: кремовый фон, малиновая плашка, портрет-иллюстрация
 *  в круге, имя, курс, дата, QR на проверку. Возвращает байты файла. */
export async function renderCertificatePng(input: {
  fullName: string;
  courseTitle: string;
  issuedAt: Date;
  lang: CertificateLanguage;
  number: number;
}): Promise<Buffer> {
  ensureCanvasFont();
  const { width, height } = CERTIFICATE_PNG_SIZE;
  const cx = width / 2;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PNG_COLOR.cream;
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Вордмарк — та же разрядка, что на обложках уроков.
  ctx.fillStyle = PNG_COLOR.raspberry;
  ctx.font = `24px "${CANVAS_FONT}"`;
  ctx.letterSpacing = "7px";
  ctx.fillText("SHIRIN SWEETS", cx, 76);
  ctx.letterSpacing = "0px";

  // Малиновая плашка «Сертификат».
  const badgeText = "СЕРТИФИКАТ";
  ctx.font = `36px "${CANVAS_FONT}"`;
  ctx.letterSpacing = "4px";
  const badgeW = ctx.measureText(badgeText).width + 80;
  const badgeH = 78;
  const badgeY = 118;
  ctx.fillStyle = PNG_COLOR.raspberry;
  roundRectPng(ctx, cx - badgeW / 2, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.fillStyle = PNG_COLOR.cream;
  ctx.fillText(badgeText, cx, badgeY + badgeH / 2 + 13);
  ctx.letterSpacing = "0px";

  // Портрет-иллюстрация в круге (см. пояснение об отклонении выше).
  const portraitSize = 360;
  const portraitTop = badgeY + badgeH + 46;
  const portraitBuf = await sharp(await fs.promises.readFile(PNG_PORTRAIT))
    .resize(portraitSize, portraitSize, { fit: "cover", position: sharp.strategy.attention })
    .png()
    .toBuffer();
  const portraitImg = await loadImage(portraitBuf);
  const portraitCy = portraitTop + portraitSize / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, portraitCy, portraitSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(portraitImg, cx - portraitSize / 2, portraitTop, portraitSize, portraitSize);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, portraitCy, portraitSize / 2 + 5, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = PNG_COLOR.raspberry;
  ctx.stroke();

  // Имя ученицы — крупно, с уменьшением кегля для длинных имён (как на PDF).
  let cursorY = portraitTop + portraitSize + 90;
  const nameSize = fitOneLine(ctx, input.fullName, width - 140, 58, 30);
  ctx.font = `${nameSize}px "${CANVAS_FONT}"`;
  ctx.fillStyle = PNG_COLOR.ink;
  boldTextPng(ctx, input.fullName, cx, cursorY, Math.max(1, nameSize * 0.03));

  // Курс.
  cursorY += 56;
  ctx.font = `20px "${CANVAS_FONT}"`;
  ctx.letterSpacing = "3px";
  ctx.fillStyle = PNG_COLOR.raspberry;
  ctx.fillText("КУРС", cx, cursorY);
  ctx.letterSpacing = "0px";
  cursorY += 44;
  ctx.font = `34px "${CANVAS_FONT}"`;
  ctx.fillStyle = PNG_COLOR.ink;
  for (const line of wrapLinesPng(ctx, input.courseTitle, width - 200, 2)) {
    ctx.fillText(line, cx, cursorY);
    cursorY += 42;
  }

  // Дата.
  cursorY += 20;
  ctx.font = `24px "${CANVAS_FONT}"`;
  ctx.fillStyle = PNG_COLOR.muted;
  ctx.fillText(`${DATE_LABEL[input.lang]}: ${formatIssueDate(input.issuedAt, input.lang)}`, cx, cursorY);

  // QR на проверку — номер сертификата подписью рядом (тот же номер печатает
  // и PDF, см. certificateFileName).
  const qrSize = 168;
  const qrBuf = await QRCode.toBuffer(verificationUrl(input.number), {
    type: "png",
    width: qrSize,
    margin: 1,
    color: { dark: PNG_COLOR.ink, light: PNG_COLOR.cream },
  });
  const qrImg = await loadImage(qrBuf);
  const qrY = height - qrSize - 96;
  ctx.drawImage(qrImg, cx - qrSize / 2, qrY, qrSize, qrSize);
  ctx.font = `20px "${CANVAS_FONT}"`;
  ctx.fillStyle = PNG_COLOR.muted;
  ctx.fillText(`№ ${input.number}`, cx, qrY + qrSize + 34);

  return canvas.toBuffer("image/png");
}

/** Имя PNG-файла — тот же принцип, что и у PDF (см. certificateFileName). */
export function certificatePngFileName(number: number, lang: CertificateLanguage): string {
  return `shirin-sweets-certificate-${lang}-${number}.png`;
}

export type CertificateVerification =
  | { found: false }
  | { found: true; fullName: string; courseTitle: string; issuedAt: string; lang: CertificateLanguage };

/**
 * ПРОВЕРКА ПО QR — публичный эндпоинт (роутер), без сессии ученицы: кто угодно
 * может навести камеру и убедиться, что документ настоящий. Отдаём только имя,
 * курс и дату — никаких контактов (телефон/Instagram) наружу.
 */
export async function verifyCertificateNumber(number: number): Promise<CertificateVerification> {
  if (!Number.isInteger(number) || number <= 0) return { found: false };
  const cert = await prisma.certificate.findFirst({
    where: { number },
    include: { course: { select: { title: true } } },
  });
  if (!cert) return { found: false };
  return {
    found: true,
    fullName: cert.fullName,
    courseTitle: cert.course.title,
    issuedAt: cert.issuedAt.toISOString(),
    lang: cert.lang === "tg" ? "tg" : "ru",
  };
}
