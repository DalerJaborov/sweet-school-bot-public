import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
// @ts-expect-error static page generator is an ESM build script.
import { loadContent, renderSite } from "../../scripts/build-site-pages.mjs";

const content = loadContent();
const files: Map<string, string> = renderSite(content);
const publicFile = (url: string) => resolve("public", new URL(url, content.site.origin).pathname.slice(1));

describe("public link previews and recognizable icons", () => {
  it("all localized pages expose a real 1200×630 JPEG and complete preview metadata", async () => {
    for (const [file, html] of files) {
      if (!file.endsWith(".html") || file === "404.html") continue;
      const url = html.match(/property="og:image" content="([^"]+)"/)![1];
      const bytes = readFileSync(publicFile(url));
      const image = await sharp(bytes).metadata();
      expect([image.width, image.height, image.format]).toEqual([1200, 630, "jpeg"]);
      expect(bytes.length).toBeLessThan(250_000);
      expect(html).toContain('property="og:image:alt"');
      expect(html).toContain('name="twitter:title"');
      expect(html).toContain('/favicon.ico?v=20261108-brand');
      expect(html).toContain('/favicon.svg?v=20261108-brand');
    }
  });
  it("provides real small favicon sizes plus Apple and opaque maskable icons", async () => {
    const ico = readFileSync(resolve("public/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48]);
    for (const [file, size] of [["icons/apple-touch-icon-180.png", 180], ["icons/icon-192.png", 192], ["icons/icon-512-maskable.png", 512]] as const) {
      const image = await sharp(resolve("public", file)).metadata();
      expect([image.width, image.height]).toEqual([size, size]);
    }
  });
  it("keeps both private apps noindex while giving them the same favicon", () => {
    for (const file of ["index.html", "course.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html).toContain('content="noindex, nofollow"');
      expect(html).toContain('/favicon.svg?v=20261108-brand');
    }
  });
});
