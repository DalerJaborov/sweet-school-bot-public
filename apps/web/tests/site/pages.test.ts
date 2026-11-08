import { describe, it, expect } from "vitest";
// @ts-expect-error — генератор на чистом ESM без типов; в тесте важен результат, не сигнатуры.
import {
  loadContent,
  renderSite,
  localHref,
  md,
  resolveSsiFallback,
  usesOfferFacts,
} from "../../scripts/build-site-pages.mjs";
import fs from "node:fs";
import path from "node:path";

/**
 * Сгенерированные страницы — то, что видит поисковик. Проверяем каркас
 * SEO на каждой: canonical на себя, взаимные hreflang, JSON-LD с
 * Organization, реальный текст (не пустая оболочка), правило «без школы»,
 * и что онлайн-цены не зашиты в статику (они только из API).
 */
const content = loadContent();
const files: Map<string, string> = renderSite(content, new Date("2026-09-03T00:00:00Z"));
const raw = [...files.entries()].filter(([f]) => f.endsWith(".html") && f !== "404.html");
// Факты очного курса приходят через Nginx SSI; без него человек видит запасные значения.
const html = raw.map(([f, b]) => [f, resolveSsiFallback(b)] as [string, string]);

describe("Статичные страницы сайта", () => {
  it("9 страниц × 2 языка + 404, sitemap, robots", () => {
    expect(html.length).toBe(18); // 9 страниц (включая политику конфиденциальности и «Арт-десерты») × 2 языка
    expect(files.has("404.html")).toBe(true);
    expect(files.has("public/sitemap.xml")).toBe(true);
    expect(files.has("public/robots.txt")).toBe(true);
  });

  it.each(html)("%s: canonical, hreflang, JSON-LD, lang, текст", (file, body) => {
    const tg = file === "site.html" || file.startsWith("tg/");
    const slug = file
      .replace(/^(tg|ru)\//, "")
      .replace(/\.html$/, "")
      .replace(/^(site|index)$/, "");
    const ru = `https://shirinsweets.online/${slug || "ru/"}`;
    const tajik = `https://shirinsweets.online${slug ? `/tg/${slug}` : "/"}`;
    const self = tg ? tajik : ru;
    expect(body).toContain(`<html lang="${tg ? "tg" : "ru"}">`);
    expect(body).toContain(`<link rel="canonical" href="${self}" />`);
    expect(body).toContain(`hreflang="ru" href="${ru}"`);
    expect(body).toContain(`hreflang="tg" href="${tajik}"`);
    expect(body).toContain(`hreflang="x-default" href="${tajik}"`);
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
    const body = resolveSsiFallback(files.get("site.html")!);
    expect(body).toContain('id="courses-island"');
    expect(body).toContain('id="offline-form-island" data-price="700"');
    expect(body).toContain('href="/course"');
    expect(body).toContain("data-chat=");
    expect(body).toContain('"@type":"WebSite"');
    expect(body).toContain('"@type":"FAQPage"');
    expect(body).toContain('id="mobile-nav"');
  });

  it("картинки: фото десерта с прелоадом и AVIF, своё og:image на каждой странице и языке", () => {
    const body = files.get("site.html")!;
    const hero = content.media.desserts["Чизкейк «Дубайский шоколад»"];
    expect(body).toContain(`rel="preload" as="image" href="${hero.avif || hero.src}"`);
    expect(body).toContain(`src="${hero.src}"`);
    expect(body).toContain(`width="${hero.width}" height="${hero.height}"`);
    expect(body).toContain('loading="lazy"');
    // Превью ссылки — своё на страницу и язык, крупная карточка.
    for (const [file, page] of html) {
      const tg = file === "site.html" || file.startsWith("tg/");
      const key = file
        .replace(/^(tg|ru)\//, "")
        .replace(/\.html$/, "")
        .replace(/^(site|index)$/, "home");
      expect(page).toContain(
        `<meta property="og:image" content="https://shirinsweets.online/img/covers/og-${key}-${tg ? "tg" : "ru"}.jpg?v=20261109-logo" />`,
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
    expect(localHref("/", "tg")).toBe("/");
    expect(localHref("/", "ru")).toBe("/ru/");
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
    // Адрес панели нигде на сайте не светим: ни в robots, ни ссылкой в подвале.
    expect(robots).not.toContain("/panel");
    expect(robots).not.toContain("/admin");
    for (const [name, html] of files) {
      if (typeof html === "string" && /\.html$/.test(name)) {
        expect(html, name).not.toMatch(/href="\/(panel|admin)/);
      }
    }
    expect(robots).not.toContain("Disallow: /course");
    expect(robots).toContain("Sitemap: https://shirinsweets.online/sitemap.xml");
  });

  it("noindex страницы исключены из sitemap", () => {
    const withHidden = {
      ...content,
      pages: content.pages.map((p: { slug: string }) => ({ ...p, noindex: p.slug === "faq" })),
    };
    const sitemap = renderSite(withHidden).get("public/sitemap.xml")!;
    expect(sitemap).not.toContain("/faq");
    expect((sitemap.match(/<loc>/g) ?? []).length).toBe(16);
  });

  it("compact pages do not preload an unused hero photograph", () => {
    for (const slug of ["faq"]) {
      const body = files.get(`${slug}.html`)!;
      expect(body).not.toContain('rel="preload" as="image"');
    }
  });

  it("страницы курсов: видео-петля в герое, 10 фото уроков, галерея офлайна, кнопка под сеткой", () => {
    for (const slug of ["online-kurs", "art-desserty", "kursy-konditera-dushanbe"]) {
      const body = files.get(`${slug}.html`)!;
      expect(body).toMatch(/<video class="hero-video"[^>]*autoplay muted loop playsinline/);
      expect(body).toMatch(/\/img\/hero\/video-[a-z]+\.mp4/);
      expect(body).toContain("section-cta");
    }
    const art = files.get("art-desserty.html")!;
    expect((art.match(/<figure class="dessert-photo">/g) ?? []).length).toBe(10);
    expect(art).not.toContain("dessert-name");
    const offline = files.get("kursy-konditera-dushanbe.html")!;
    expect(offline).toContain('id="desserty"');
    expect((offline.match(/<figure class="dessert-photo/g) ?? []).length).toBe(21);
  });

  it("оплата вручную, реальная программа арт-десертов и актуальные часы", () => {
    const art = files.get("art-desserty.html")!;
    expect(art).toContain("10 уроков");
    expect(art).toContain("Начинки: манго, лимон, клубника");
    expect(art).not.toMatch(/макарон|Три шоколада|Бот проверяет чек|чек в чат на сайте/i);
    expect(files.get("tg/art-desserty.html")).toContain("10 дарс");
    for (const [, body] of html) {
      // Адрес 08.11.2026 (вечер, карточка владельца): «Рудаки 156, Воданасос, дом Додо Пицца»;
      // старые «156а» и «Водонасос» больше нигде не звучат.
      expect(body).not.toMatch(/14:00|17:00|156а|Водонасос|Рудаки 177|Пример отзыва|Мадина|Нигора|Фарзона/);
    }
    expect(files.get("kursy-konditera-dushanbe.html")).toContain("13:40–16:30");
    expect(files.get("ru/index.html")).toContain("Клубника в шоколаде");
    expect(files.get("site.html")).toContain("Тути фаранг дар шоколад");
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

describe("Факты очного курса — из панели через SSI (08.11.2026)", () => {
  const nginx = fs.readFileSync(path.resolve(__dirname, "../../nginx.conf"), "utf8");
  const ssiRoute = new RegExp(nginx.match(/location ~ (\^\/\(site\\\.html[^ ]+\$) \{\n\s+ssi on;/)![1]);
  const route = (file: string) =>
    file.endsWith("index.html") || file === "site.html" ? `/${file}` : `/${file.replace(/\.html$/, "")}`;

  it("каждая страница с {{offline.*}} отдаётся Nginx с ssi on", () => {
    const pages = raw.filter(([, b]) => usesOfferFacts(b)).map(([f]) => f);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const file of pages) expect(ssiRoute.test(route(file)), file).toBe(true);
  });

  it("ни одной сырой подстановки {{…}} в готовом HTML", () => {
    for (const [file, body] of raw) expect(body, file).not.toMatch(/\{\{\s*offline/);
  });

  it("цена, часы и 21 десерт — в title, тексте и карточке очного курса", () => {
    const body = files.get("kursy-konditera-dushanbe.html")!;
    expect(body).toMatch(/<title>[\s\S]*?offer-fact\?key=offline\.price[\s\S]*?<\/title>/);
    const plain = resolveSsiFallback(body);
    expect(plain).toMatch(/<title>[^<]*700 сомони/);
    expect(plain).toContain("с 13:40 до 16:30");
    expect(plain).toContain("Программа: 21 десерт за 8 дней");
    expect(resolveSsiFallback(files.get("tg/kursy-konditera-dushanbe.html")!)).toMatch(
      /name="description" content="[^"]*700 сомонӣ/,
    );
  });
});

describe("Адрес очного курса — одно поле панели (08.11.2026)", () => {
  it("подвал, ссылка на карту и JSON-LD каждой страницы — из /_site/offer-fact, с запасным «Рудаки 156, Воданасос, дом Додо Пицца»", () => {
    for (const [file, body] of raw) {
      const lang = file === "site.html" || file.startsWith("tg/") ? "tg" : "ru";
      expect(body, file).toContain(`offer-fact?key=contact.address&lang=${lang}`);
      expect(body, file).toContain(`offer-fact?key=contact.street&lang=${lang}`);
      expect(body, file).toContain("offer-fact?key=contact.mapsQuery");
      const plain = resolveSsiFallback(body);
      expect(plain, file).toContain(
        lang === "tg" ? "Душанбе, Рудаки 156, Воданасос, доми Додо Пицца" : "Душанбе, Рудаки 156, Воданасос, дом Додо Пицца",
      );
      expect(plain, file).toContain(
        `https://maps.google.com/?q=${encodeURIComponent("Душанбе, Рудаки 156, Воданасос, дом Додо Пицца")}`,
      );
      const ld = plain.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
      expect(JSON.stringify(JSON.parse(ld))).toMatch(
        /"streetAddress":"Рудаки 156, Воданасос, доми? Додо Пицца"/,
      );
    }
  });

  it("hero crossfades 5 real dessert photos: first is LCP, the rest lazy and decorative; reduced motion stays static", () => {
    const body = files.get("ru/index.html")!;
    const start = body.indexOf('<div class="hero-photo hero-slides"');
    const slot = body.slice(start, body.indexOf("</section>", start));
    expect(start).toBeGreaterThan(0);
    expect(slot).toContain('data-slides="5"');
    expect(slot.split("<img ").length - 1).toBe(5);
    expect(slot.split('fetchpriority="high"').length - 1).toBe(1);
    expect(slot.split('loading="lazy"').length - 1).toBe(4);
    expect(
      slot.split('class="hero-slide-wrap"').length - 1 + slot.split('class="hero-slide-wrap" ').length - 1,
    ).toBeGreaterThanOrEqual(0);
    expect(slot.split('aria-hidden="true"').length - 1).toBeGreaterThanOrEqual(4);
    const css = fs.readFileSync("src/site/site.css", "utf8");
    const rm = css.slice(css.indexOf("prefers-reduced-motion: reduce", css.indexOf(".hero-slides")));
    expect(rm.slice(0, 260)).toContain(".hero-slide-wrap { display: none; }");
  });

  it("online-course program shows all 21 desserts as a grid, in Russian on both languages", () => {
    const { site } = content;
    for (const key of ["online-kurs.html", "tg/online-kurs.html"]) {
      const body = files.get(key)!;
      const start = body.indexOf('<div class="dessert-all">');
      expect(start).toBeGreaterThan(0);
      const grid = body.slice(start, body.indexOf("</section>", start));
      expect(grid.split("<figure ").length - 1).toBe(21);
      expect(body).not.toContain('class="dessert-scroll"');
      for (const d of site.desserts) expect(grid).toContain(d.ru.replace(/"/g, "&quot;").replace(/«/g, "«"));
    }
  });
});
