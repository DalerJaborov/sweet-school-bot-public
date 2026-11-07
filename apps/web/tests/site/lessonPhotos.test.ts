import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it } from "vitest";

it("preserves documentary originals and ships only same-size, bounded photo corrections", async () => {
  const audit = JSON.parse(readFileSync("site-content/lesson-photo-corrections.json", "utf8"));
  const media = readFileSync("site-content/media.json", "utf8");
  expect(audit.records).toHaveLength(13);
  let totalBytes = 0;
  for (const item of audit.records) {
    const source = readFileSync(`public${item.source}`);
    const output = readFileSync(`public${item.output}`);
    expect(createHash("sha256").update(source).digest("hex")).toBe(item.sha256);
    expect(media).toContain(item.output);
    expect(media).not.toContain(`"${item.source}"`);
    const before = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const after = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(after.info).toEqual(before.info);
    expect([after.info.width, after.info.height]).toEqual([item.width, item.height]);
    let absoluteDifference = 0;
    for (let i = 0; i < before.data.length; i++) absoluteDifference += Math.abs(before.data[i] - after.data[i]);
    // A small pointwise difference catches accidental substitutions, crops, or regeneration.
    expect(absoluteDifference / before.data.length).toBeLessThan(6);
    expect(output.length).toBeLessThan(100_000);
    totalBytes += output.length;
  }
  expect(totalBytes).toBeLessThan(650_000);
});
