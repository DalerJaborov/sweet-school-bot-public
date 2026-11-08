/**
 * Shirin brand logo as clean vector. Paths in brand/shirin-paths.json were traced from the owner's
 * original (_context/brand/shirin-logo-red-original.png, 447 px) and split into the piping bag (bag)
 * and the lettering "SHIRIN сладкий мир" (text). Colors are sampled from the original.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { bag, text, silhouette } = JSON.parse(fs.readFileSync(path.join(web, "brand/shirin-paths.json"), "utf8"));

export const BRAND_RED = "#9c0004";
export const BRAND_CREAM = "#f4debf";

// Tight bounds inside the 447x447 source (measured from the traced paths).
export const BAG_BOX = { x: 119, y: 14, w: 209, h: 253 };
export const TEXT_BOX = { x: 83, y: 263, w: 276, h: 111 };

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Original square lockup: bag + SHIRIN + tagline, cream on red. */
export const fullLogoSvg = () =>
  `<svg ${NS} viewBox="0 0 447 447" role="img" aria-label="Shirin — сладкий мир"><rect width="447" height="447" fill="${BRAND_RED}"/><path fill="${BRAND_CREAM}" fill-rule="evenodd" d="${bag} ${text}"/></svg>\n`;

/** Lettering only, one flat color via CSS (mask-image) — works on any theme. */
export const wordmarkSvg = (fill = "#000") => {
  const b = TEXT_BOX;
  return `<svg ${NS} viewBox="${b.x} ${b.y} ${b.w} ${b.h}"><path fill="${fill}" fill-rule="evenodd" d="${text}"/></svg>\n`;
};

/** Bag only, flat color (mask-image for the footer / panel). */
export const bagSvg = (fill = "#000") => {
  const b = BAG_BOX;
  return `<svg ${NS} viewBox="${b.x} ${b.y} ${b.w} ${b.h}"><path fill="${fill}" fill-rule="evenodd" d="${bag}"/></svg>\n`;
};

/**
 * App/favicon icon: the bag only on the brand red. A cream stroke thickens the hairlines so the bag
 * stays readable at 16 px; `solid` fills the outer silhouette instead (tiny sizes). `radius` 0 gives the opaque full-bleed variant (maskable).
 */
export const markSvg = ({ radius = 112, scale = 0.74, stroke = 3, solid = false } = {}) => {
  const b = BAG_BOX;
  const k = (512 * scale) / b.h;
  const tx = (512 - b.w * k) / 2 - b.x * k;
  const ty = (512 - b.h * k) / 2 - b.y * k;
  return `<svg ${NS} viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${BRAND_RED}"/><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${solid ? `<path fill="${BRAND_CREAM}" stroke="${BRAND_CREAM}" stroke-width="2" stroke-linejoin="round" d="${silhouette}"/>` : `<path fill="${BRAND_CREAM}" stroke="${BRAND_CREAM}" stroke-width="${stroke}" stroke-linejoin="round" fill-rule="evenodd" d="${bag}"/>`}</g></svg>\n`;
};
