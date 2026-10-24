import { describe, it, expect } from "vitest";
// @ts-expect-error — генератор на чистом ESM без типов; в тесте важен результат, не сигнатуры.
import { loadContent, renderSite, localHref, md } from "../../scripts/build-site-pages.mjs";

/**
 * Сгенерированные страницы — то, что видит поисковик. Проверяем каркас
 * SEO на каждой: canonical на себя, взаимные hreflang, JSON-LD с
 * Organization, реальный текст (не пустая оболочка), правило «без школы»,
 * и что онлайн-цены не зашиты в статику (они только из API).
 */
const content = loadContent();
const files: Map<string, string> = renderSite(content, new Date("2026-09-03T00:00:00Z"));
const html = [...files.entries()].filter(([f]) => f.endsWith(".html") && f !== "404.html");

describe("Статичные страницы сайта", () => {
  it("9 страниц × 2 языка + 404, sitemap, robots", () => {
    expect(html.length).toBe(18); // 9 страниц (включая политику конфиденциальности и «Арт-десерты») × 2 языка
    expect(files.has("404.html")).toBe(true);
    expect(files.has("public/sitemap.xml")).toBe(true);
    expect(files.has("public/robots.txt")).toBe(true);
  });

  it.each(html)("%s: canonical, hreflang, JSON-LD, lang, текст", (file, body) => {
    const tg = file.startsWith("tg/");
    const slug = file
      .replace(/^tg\//, "")
      .replace(/\.html$/, "")
      .replace(/^(site|index)$/, "");
    const self = `https://shirinsweets.online${tg ? "/tg" : ""}/${slug}`;
    expect(body).toContain(`<html lang="${tg ? "tg" : "ru"}">`);
    expect(body).toContain(`<link rel="canonical" href="${self}" />`);
    expect(body).toContain(`hreflang="ru" href="https://shirinsweets.online/${slug}"`);
    expect(body).toContain(`hreflang="tg" href="https://shirinsweets.online/tg/${slug}"`);
    expect(body).toContain(`hreflang="x-default" href="https://shirinsweets.online/${slug}"`);
    expect(body).toMatch(/<meta property="og:title" content=".+"/);
    expect(body).toMatch(/<meta name="description" content=".+"/);
    const ld = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(ld).not.toBeNull();
    const graph = JSON.parse(ld![1])["@graph"] as { "@type": string }[];
    const types = graph.map((g) => g["@type"]);
    expect(types).toContain("Organization");
    if (slug) expect(types).toContain("BreadcrumbList");
    expect(body).toMatch(/<h1 class="h1">[^<]{10,}<\/h1>/);
    expect(body).toContain('src="/src/site/main.tsx"');
    expect(/школ/i.test(body)).toBe(false);
    const prices = [...body.matchAll(/(\d{2,4})\s*сомон/g)].map((m) => Number(m[1]));
    expect(prices.every((p) => p === 700)).toBe(true);
  });

  it("главная: WebSite + FAQPage, островки курсов и формы, оба CTA", () => {
    const body = files.get("site.html")!;
    expect(body).toContain('id="courses-island"');
    expect(body).toContain('id="offline-form-island" data-price="700"');
    expect(body).toContain('href="/course"');
    expect(body).toContain("data-chat=");
    expect(body).toContain('"@type":"WebSite"');
    expect(body).toContain('"@type":"FAQPage"');
    expect(body).toContain('id="mobile-nav"');
  });

  it("картинки: герой-коллаж с прелоадом и AVIF, своё og:image на каждой странице и языке", () => {
    const body = files.get("site.html")!;
    // LCP: прелоад совпадает с кандидатами <img> (imagesrcset/imagesizes), иначе качается дважды.
    expect(body).toMatch(
      /<link rel="preload" as="image" href="\/img\/covers\/hero\.avif" type="image\/avif" imagesrcset="[^"]+" imagesizes="[^"]+" fetchpriority="high" \/>/,
    );
    expect(body).toContain(
      '<picture><source type="image/avif" srcset="/img/covers/hero-sm.avif 500w, /img/covers/hero.avif 1000w"',
    );
    expect(body).toMatch(
      /<img src="\/img\/covers\/hero\.webp"[^>]*width="1000" height="1250"[^>]*fetchpriority="high"/,
    );
    // Плитки десертов: явные размеры и lazy — без сдвига раскладки.
    expect(body).toMatch(
      /<img src="\/img\/desserts\/[^"]+\.webp" srcset="[^"]+" sizes="[^"]+" width="800" height="800" alt="[^"]+" loading="lazy"/,
    );
    // Превью ссылки — своё на страницу и язык, крупная карточка.
    for (const [file, page] of html) {
      const tg = file.startsWith("tg/");
      const key = file
        .replace(/^tg\//, "")
        .replace(/\.html$/, "")
        .replace(/^(site|index)$/, "home");
      expect(page).toContain(
        `<meta property="og:image" content="https://shirinsweets.online/img/covers/og-${key}-${tg ? "tg" : "ru"}.jpg" />`,
      );
      expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
    }
  });

  it("курс-страницы: Course без выдуманных часов и наличия мест", () => {
    const on = files.get("online-kurs.html")!;
    const off = files.get("kursy-konditera-dushanbe.html")!;
    expect(on).toContain('"courseMode":"online"');
    expect(on).not.toContain('"offers"');
    expect(off).toContain('"courseMode":"onsite"');
    expect(off).not.toContain('"offers"');
    expect(off).not.toContain('"courseSchedule"');
    expect(on).not.toContain('"courseWorkload"');
    expect(on).toContain('"inLanguage":"tg"');
  });

  it("таджикское зеркало ссылается на /tg/, а приложения — без префикса", () => {
    const body = files.get("tg/online-kurs.html")!;
    expect(body).toContain('href="/tg/faq"');
    expect(body).toContain('href="/course"');
    expect(body).not.toContain('href="/tg/course"');
    expect(localHref("/faq", "tg")).toBe("/tg/faq");
    expect(localHref("/", "tg")).toBe("/tg/");
    expect(localHref("/l/abc", "tg")).toBe("/l/abc");
    expect(localHref("#offline", "tg")).toBe("#offline");
  });

  it("sitemap: все адреса с xhtml:link без ложной даты обновления; noindex доступен роботу", () => {
    const sm = files.get("public/sitemap.xml")!;
    expect((sm.match(/<loc>/g) ?? []).length).toBe(18);
    expect(sm).toContain('xhtml:link rel="alternate" hreflang="tg" href="https://shirinsweets.online/tg/faq"');
    expect(sm).not.toContain("<lastmod>");
    const robots = files.get("public/robots.txt")!;
    expect(robots).toContain("Disallow: /api/");
    expect(robots).not.toContain("Disallow: /panel");
    expect(robots).not.toContain("Disallow: /course");
    expect(robots).toContain("Sitemap: https://shirinsweets.online/sitemap.xml");
  });

  it("noindex страницы исключены из sitemap", () => {
    const withHidden = { ...content, pages: content.pages.map((p: { slug: string }) => ({ ...p, noindex: p.slug === "faq" })) };
    const sitemap = renderSite(withHidden).get("public/sitemap.xml")!;
    expect(sitemap).not.toContain("/faq");
    expect((sitemap.match(/<loc>/g) ?? []).length).toBe(16);
  });

  it("прелоад использует обложку самой страницы и её AVIF, а не главную", () => {
    const body = files.get("online-kurs.html")!;
    const entry = content.media.heroPages["online-kurs"];
    const preload = body.match(/<link rel="preload" as="image"[^>]+>/)![0];
    expect(preload).toContain(`href="${entry.avif || entry.src}"`);
    expect(preload).not.toContain('href="/img/covers/hero.avif"');
  });

  it("оплата вручную, реальная программа арт-десертов и актуальные часы", () => {
    const art = files.get("art-desserty.html")!;
    expect(art).toContain("10 уроков");
    expect(art).toContain("Начинки: манго, лимон, клубника");
    expect(art).not.toMatch(/макарон|Три шоколада|Бот проверяет чек|чек в чат на сайте/i);
    expect(files.get("tg/art-desserty.html")).toContain("10 дарс");
    for (const [, body] of html) {
      expect(body).not.toMatch(/14:00|17:00|Рудаки|Пример отзыва|Мадина|Нигора|Фарзона/);
    }
    expect(files.get("kursy-konditera-dushanbe.html")).toContain("13:40–16:30");
    expect(files.get("site.html")).toContain("Клубника в шоколаде");
    expect(files.get("tg/index.html")).toContain("Тути фаранг дар шоколад");
    expect(files.get("404.html")).not.toContain('rel="alternate"');
  });

  it("mini-markdown экранирует HTML и локализует ссылки", () => {
    const ctx = { wa: "https://wa.me/1", ui: { ctaBuyPrefill: "x" } };
    expect(md("<b>a</b> **b** [c](/faq)", "tg", ctx)).toBe(
      '&lt;b&gt;a&lt;/b&gt; <strong>b</strong> <a href="/tg/faq">c</a>',
    );
    expect(md("[buy](chat:)", "ru", ctx)).toContain('data-chat="x"');
  });
});
