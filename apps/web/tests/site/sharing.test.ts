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
  it("versions all icon references in public and authenticated manifests", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
    for (const icon of manifest.icons) expect(icon.src).toMatch(/\?v=20261109-logo$/);
    const api = readFileSync("../api/src/course/router.ts", "utf8");
    for (const name of ["icon-192", "icon-512", "icon-512-maskable"]) expect(api).toContain(`/icons/${name}.png?v=20261109-logo`);
    for (const file of ["index.html", "course.html"]) expect(readFileSync(file, "utf8")).toContain('/icons/apple-touch-icon-180.png?v=20261109-logo');
  });
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
      expect(html).toContain('/favicon.ico?v=20261109-logo');
      expect(html).toContain('/favicon.svg?v=20261109-logo');
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
      expect(html).toContain('/favicon.svg?v=20261109-logo');
    }
  });

  it("ships the real red Shirin logo files and uses them in header, footer and JSON-LD", async () => {
    for (const file of ["img/brand/shirin-logo.svg", "img/brand/shirin-wordmark.svg", "img/brand/shirin-bag.svg", "favicon.svg"]) {
      expect(readFileSync(resolve("public", file), "utf8")).toContain("<svg");
    }
    expect(readFileSync(resolve("public/favicon.svg"), "utf8")).toContain("#9c0004");
    const big = await sharp(resolve("public/icons/icon-512.png")).metadata();
    expect([big.width, big.height]).toEqual([512, 512]);
    const { data, info } = await sharp(resolve("public/icons/icon-512.png")).raw().toBuffer({ resolveWithObject: true });
    const at = (256 * 512 + 40) * info.channels;
    // Corner pixel is the brand red (not the old terracotta #a8553a), within tolerance for resampling.
    expect(Math.abs(data[at] - 0x9c)).toBeLessThan(6);
    expect(data[at + 1]).toBeLessThan(6);
    const home = files.get("site.html")!;
    expect(home).toContain('class="logo-word"');
    expect(home).toContain("/img/brand/shirin-logo.svg?v=20261109-logo");
    expect(home).not.toContain("logo-mark");
    const ld = JSON.stringify([...home.matchAll(/"logo":s*"([^"]+)"/g)].map((m) => m[1]));
    expect(ld).toContain("/icons/icon-512.png?v=20261109-logo");
  });
});
