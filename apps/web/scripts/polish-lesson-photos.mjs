/** Documentary photo correction: no crop, resize, synthesis, or altered geometry.
 * Originals remain beside the versioned outputs. Re-run from any directory. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = ["art-pistachio", "blueberry", "cherry", "coconut", "coffee", "dubai", "mango", "pistachio", "raspberry", "snickers", "trifle", "velvet", "whoopie"];
const version = "photo-v2";
const records = [];
for (const name of names) {
  const source = `/img/lessons/${name}.webp`;
  const output = `/img/lessons/${name}-${version}.webp`;
  const bytes = await fs.readFile(path.join(root, "public", source));
  const metadata = await sharp(bytes).metadata();
  // Mild global adjustments retain the original highlights and food colours.
  const corrected = await sharp(bytes)
    .modulate({ brightness: 1.015, saturation: 0.98 })
    .sharpen({ sigma: 0.3, m1: 0.3, m2: 0.5 })
    .webp({ quality: 85, effort: 6 }).toBuffer();
  await fs.writeFile(path.join(root, "public", output), corrected);
  records.push({ source, output, sha256: createHash("sha256").update(bytes).digest("hex"), width: metadata.width, height: metadata.height, sourceBytes: bytes.length, outputBytes: corrected.length });
}
const mediaFile = path.join(root, "site-content/media.json");
let media = await fs.readFile(mediaFile, "utf8");
for (const { source, output } of records) media = media.replaceAll(`"${source}"`, `"${output}"`);
await fs.writeFile(mediaFile, media);
await fs.writeFile(path.join(root, "site-content/lesson-photo-corrections.json"), JSON.stringify({ method: "brightness 1.015; saturation 0.98; sharpen sigma 0.3 m1 0.3 m2 0.5; WebP quality 85; no resize/crop", records }, null, 2) + "\n");
console.log(`Corrected ${records.length} photos; original bytes retained.`);
