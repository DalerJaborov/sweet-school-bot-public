import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Pure ESM build tool, intentionally shared with the CLI.
import { auditSite, auditBuiltSite } from "../../scripts/check-site-seo.mjs";
// @ts-expect-error Pure ESM generator.
import { loadContent, renderSite } from "../../scripts/build-site-pages.mjs";

const origin = "https://shirinsweets.online";

/** Small independent fixture: mutations exercise the checker, not generator snapshots. */
function fixture() {
  const files = new Map<string, string>();
  const urls: string[] = [];
  for (const slug of ["", "faq"]) {
    for (const lang of ["ru", "tg"]) {
      const prefix = lang === "tg" ? "/tg/" : "/";
      const url = `${origin}${prefix}${slug}`;
      const name = slug || (lang === "ru" ? "site" : "index");
      const file = `${lang === "tg" ? "tg/" : ""}${name}.html`;
      urls.push(url);
      files.set(file, `<!doctype html><html lang="${lang}"><head>
        <title>${lang} ${slug || "Home"}</title>
        <meta name="description" content="Description ${lang} ${slug || "Home"}">
        <link rel="canonical" href="${url}">
        <link rel="alternate" hreflang="ru" href="${origin}/${slug}">
        <link rel="alternate" hreflang="tg" href="${origin}/tg/${slug}">
        <link rel="alternate" hreflang="x-default" href="${origin}/${slug}">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>
        </head><body><h1>${lang} ${slug || "Home"}</h1><section id="answer">Answer</section>
        <a href="${prefix}faq#answer">FAQ</a><a href="/course/lesson">Lessons</a>
        <a href="https://example.invalid/article#remote">External syntax only</a>
        <a href="mailto:hello@example.invalid">Email</a><a href="tel:+992123456789">Phone</a>
        </body></html>`);
    }
  }
  files.set("public/sitemap.xml", `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`);
  return files;
}

function change(files: Map<string, string>, file: string, before: string, after: string) {
  const html = files.get(file)!;
  expect(html).toContain(before); // A mutation must really hit its intended fixture.
  files.set(file, html.replace(before, after));
}

function codes(files: Map<string, string>) {
  return auditSite(files, { origin }).errors.map((error: { code: string }) => error.code);
}

describe("Offline public-site SEO guard", () => {
  it("checks current generated pages without hardcoding the number of routes", () => {
    const content = loadContent();
    const result = auditSite(renderSite(content), { origin: content.site.origin });
    expect(result.errors).toEqual([]);
    expect(result.indexableCount).toBeGreaterThan(0);
  });

  it("accepts a coherent multilingual site and does not fetch external URLs", () => {
    expect(codes(fixture())).toEqual([]);
  });

  it.each(["/missing", "/coursework", "/tg/course"])("rejects an unknown route %s without broad app-prefix exemptions", (href) => {
    const files = fixture();
    change(files, "site.html", 'href="/faq#answer"', `href="${href}"`);
    expect(codes(files)).toContain("broken-link");
  });

  it.each(["#missing", "/faq#missing", "/tg/faq#missing"])("checks same-page and cross-page fragments: %s", (href) => {
    const files = fixture();
    change(files, "site.html", 'href="/faq#answer"', `href="${href}"`);
    expect(codes(files)).toContain("broken-anchor");
  });

  it("decodes legitimate UTF-8 anchors and ignores query parameters for route lookup", () => {
    const files = fixture();
    change(files, "faq.html", 'id="answer"', 'id="answer"></section><section id="савол"');
    change(files, "site.html", 'href="/faq#answer"', 'href="/faq?source=homepage#%D1%81%D0%B0%D0%B2%D0%BE%D0%BB"');
    expect(codes(files)).toEqual([]);
  });

  it("rejects malformed fragment encoding", () => {
    const files = fixture();
    change(files, "site.html", 'href="/faq#answer"', 'href="/faq#%ZZ"');
    expect(codes(files)).toContain("invalid-anchor");
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "https://[bad", "mailto:"])("rejects invalid or executable links: %s", (href) => {
    const files = fixture();
    change(files, "site.html", 'href="/faq#answer"', `href="${href}"`);
    expect(codes(files)).toContain("invalid-link");
  });

  it("detects duplicate titles and descriptions across public pages", () => {
    const files = fixture();
    change(files, "faq.html", "<title>ru faq</title>", "<title>ru Home</title>");
    change(files, "faq.html", 'content="Description ru faq"', 'content="Description ru Home"');
    expect(codes(files)).toEqual(expect.arrayContaining(["duplicate-title", "duplicate-description"]));
  });

  it("rejects missing descriptions and additional h1 headings", () => {
    const files = fixture();
    change(files, "site.html", 'content="Description ru Home"', 'content=" "');
    change(files, "site.html", "</body>", "<h1>Another title</h1></body>");
    expect(codes(files)).toEqual(expect.arrayContaining(["invalid-description", "invalid-h1"]));
  });

  it("catches a translated page canonicalized to its source language", () => {
    const files = fixture();
    change(files, "tg/faq.html", `rel="canonical" href="${origin}/tg/faq"`, `rel="canonical" href="${origin}/faq"`);
    expect(codes(files)).toContain("invalid-canonical");
  });

  it("rejects a wrong hreflang code even when the URL exists", () => {
    const files = fixture();
    change(files, "site.html", 'hreflang="tg"', 'hreflang="tj"');
    expect(codes(files)).toEqual(expect.arrayContaining(["invalid-hreflang", "missing-hreflang"]));
  });

  it("catches missing reciprocal alternates and wrong translation clusters", () => {
    const files = fixture();
    change(files, "tg/faq.html", `hreflang="ru" href="${origin}/faq"`, `hreflang="ru" href="${origin}/"`);
    expect(codes(files)).toContain("nonreciprocal-hreflang");
  });

  it("rejects broken hreflang URLs", () => {
    const files = fixture();
    change(files, "faq.html", `hreflang="tg" href="${origin}/tg/faq"`, `hreflang="tg" href="${origin}/tg/missing"`);
    expect(codes(files)).toContain("invalid-hreflang-target");
  });

  it("rejects malformed JSON-LD without running embedded scripts", () => {
    const files = fixture();
    change(files, "site.html", '"@type":"WebPage"', '"@type":');
    expect(codes(files)).toContain("invalid-jsonld");
  });

  it("requires sitemap URLs to equal the indexable canonical set", () => {
    const files = fixture();
    change(files, "public/sitemap.xml", `<loc>${origin}/faq</loc>`, `<loc>${origin}/nonexistent</loc>`);
    expect(codes(files)).toEqual(expect.arrayContaining(["unexpected-sitemap-url", "missing-sitemap-url"]));
  });

  it("detects duplicate sitemap entries", () => {
    const files = fixture();
    change(files, "public/sitemap.xml", "</urlset>", `<url><loc>${origin}/</loc></url></urlset>`);
    expect(codes(files)).toContain("duplicate-sitemap-url");
  });

  it("does not permit noindex pages in sitemap or language alternatives", () => {
    const files = fixture();
    change(files, "faq.html", "</head>", '<meta name="robots" content="noindex, follow"></head>');
    expect(codes(files)).toEqual(expect.arrayContaining(["unexpected-sitemap-url", "invalid-hreflang-target"]));
  });

  it("rejects malformed XML and a missing sitemap", () => {
    const files = fixture();
    files.set("public/sitemap.xml", "<urlset>");
    expect(codes(files)).toContain("invalid-sitemap");
    files.delete("public/sitemap.xml");
    expect(codes(files)).toContain("missing-sitemap");
  });

  it("requires working catalogue SSI directives, not only a React container", () => {
    const files = fixture();
    const catalog = '<div id="courses-island" data-course="COURSE50"><!--# block name="catalog-fallback" --><p>Contact us</p><!--# endblock --><!--# include virtual="/_site/catalog-fragment?lang=ru&only=COURSE50" stub="catalog-fallback" --></div>';
    change(files, "site.html", "</body>", `${catalog}</body>`);
    expect(codes(files)).toEqual([]);
    change(files, "site.html", "lang=ru&only=COURSE50", "lang=tg&only=COURSE50");
    expect(codes(files)).toContain("invalid-catalog-ssi");
    change(files, "site.html", "lang=tg&only=COURSE50", "lang=ru&only=COURSE50");
    change(files, "site.html", '<!--# block name="catalog-fallback" -->', "");
    expect(codes(files)).toContain("invalid-catalog-ssi");
  });

  it("reads actual artifacts and detects missing files, stripped SSI and indexable private apps", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shirin-seo-dist-"));
    try {
      const content = loadContent();
      const rendered: Map<string, string> = renderSite(content);
      for (const [file, html] of rendered) {
        const destination = path.join(directory, file.replace(/^public\//, ""));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, html);
      }
      for (const file of ["index.html", "course.html"]) {
        fs.writeFileSync(path.join(directory, file), '<html><head><meta name="robots" content="noindex, nofollow"></head><body></body></html>');
      }
      expect(auditBuiltSite(directory, content).errors).toEqual([]);
      const catalogFile = [...rendered].find(([, html]) => html.includes('id="courses-island"'))![0];
      const catalogPath = path.join(directory, catalogFile);
      const original = fs.readFileSync(catalogPath, "utf8");
      fs.writeFileSync(catalogPath, original.replace(/<!--#[\s\S]*?-->/g, ""));
      fs.writeFileSync(path.join(directory, "course.html"), '<html><head><title>Lessons</title></head><body></body></html>');
      fs.unlinkSync(path.join(directory, "tg", "faq.html"));
      const found = auditBuiltSite(directory, content).errors.map((error: { code: string }) => error.code);
      expect(found).toEqual(expect.arrayContaining(["invalid-catalog-ssi", "private-app-indexable", "missing-build-artifact"]));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
