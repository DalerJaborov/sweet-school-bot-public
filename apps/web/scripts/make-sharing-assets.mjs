/** Reproducible favicon and social cards from existing course photos and color tokens. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { loadContent } from "./build-site-pages.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(web, "public");
const tokens = fs.readFileSync(path.join(web, "src/tokens.css"), "utf8");
const color = (name) => {
  const value = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]+);`, "i"))?.[1];
  if (!value) throw new Error(`Missing token ${name}`);
  return value;
};
const accent = color("c-accent"), paper = color("c-bg"), ink = color("c-ink"), white = color("c-white");
const cupcake = `<path fill="${white}" d="M152 205c0-27 22-48 49-48h7a59 59 0 0 1 96 0h7c27 0 49 21 49 48H152Zm-2 25h212l-32 170c-46 17-102 17-148 0l-32-170Z"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${accent}"/><g transform="translate(-51 -51) scale(1.2)">${cupcake}</g></svg>`;
fs.writeFileSync(path.join(pub, "favicon.svg"), svg);
const icons = [16, 32, 48, 180, 192, 512];
const pngs = new Map();
for (const size of icons) pngs.set(size, await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer());
for (const size of [16, 32, 48]) fs.writeFileSync(path.join(pub, `icons/favicon-${size}.png`), pngs.get(size));
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(pub, `icons/icon-${size}.png`), pngs.get(size));
  fs.writeFileSync(path.join(pub, `icon-${size}.png`), pngs.get(size));
}
fs.writeFileSync(path.join(pub, "icons/apple-touch-icon-180.png"), pngs.get(180));
// Maskable icon is opaque, with all meaningful artwork inside the central safe circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${accent}"/>${cupcake}</svg>`;
fs.writeFileSync(path.join(pub, "icons/icon-512-maskable.png"), await sharp(Buffer.from(maskable)).png().toBuffer());
const sizes = [16, 32, 48];
const ico = Buffer.alloc(6 + 16 * sizes.length);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(sizes.length, 4);
let offset = ico.length;
sizes.forEach((size, i) => {
  const at = 6 + i * 16, png = pngs.get(size);
  ico[at] = size; ico[at + 1] = size; ico.writeUInt16LE(1, at + 4); ico.writeUInt16LE(32, at + 6);
  ico.writeUInt32LE(png.length, at + 8); ico.writeUInt32LE(offset, at + 12); offset += png.length;
});
fs.writeFileSync(path.join(pub, "favicon.ico"), Buffer.concat([ico, ...sizes.map((s) => pngs.get(s))]));

GlobalFonts.registerFromPath(path.join(web, "../api/assets/fonts/NotoSans-Regular.ttf"), "Shirin");
const { site, pages, media } = loadContent();
const samples = media.lessonSamples;
for (const page of pages) for (const lang of ["ru", "tg"]) {
  const canvas = createCanvas(1200, 630), ctx = canvas.getContext("2d");
  ctx.fillStyle = paper; ctx.fillRect(0, 0, 1200, 630);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, 1200, 110);
  const icon = await loadImage(pngs.get(48)); ctx.drawImage(icon, 48, 30, 48, 48);
  ctx.fillStyle = white; ctx.font = '32px "Shirin"'; ctx.fillText(site.brand, 112, 69);
  const sample = samples[page.slug === "art-desserty" ? 6 : page.slug === "kursy-konditera-dushanbe" ? 4 : 3];
  const photo = await sharp(path.join(pub, sample.image.src)).resize(460, 460, { fit: "cover", position: "centre" }).png().toBuffer();
  ctx.drawImage(await loadImage(photo), 700, 140, 460, 460);
  const title = page.h1[lang] ?? page.h1.ru;
  let lines = [], size = 54;
  for (; size >= 30; size -= 2) {
    ctx.font = `${size}px "Shirin"`; lines = []; let line = "";
    for (const word of title.split(/\s+/)) {
      const next = `${line} ${word}`.trim();
      if (line && ctx.measureText(next).width > 598) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length <= 5) break;
  }
  ctx.fillStyle = ink; ctx.font = `${size}px "Shirin"`;
  lines.forEach((line, i) => ctx.fillText(line, 48, 200 + i * size * 1.2));
  ctx.fillStyle = accent; ctx.font = '24px "Shirin"'; ctx.fillText('shirinsweets.online', 48, 575);
  const file = path.join(pub, media.ogPages[page.slug][lang]);
  await sharp(canvas.toBuffer("image/png")).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
}
fs.copyFileSync(path.join(pub, media.ogPages[""]["tg"]), path.join(pub, "img/og.jpg"));
const manifestPath = path.join(pub, "manifest.webmanifest");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.name = site.brand; manifest.short_name = "Shirin"; manifest.lang = "tg";
manifest.theme_color = accent; manifest.background_color = paper;
manifest.icons.find((icon) => icon.purpose === "maskable").src = "/icons/icon-512-maskable.png";
for (const icon of manifest.icons) icon.src = icon.src.split("?")[0] + "?v=20261108-brand";
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Brand assets: favicon ICO/SVG/PNG, app icons, ${pages.length * 2} localized social cards.`);
