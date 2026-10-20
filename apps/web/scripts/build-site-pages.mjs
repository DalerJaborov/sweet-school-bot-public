/**
 * Генератор статичных страниц сайта shirinsweets.online.
 *
 * Зачем: поисковику нужен готовый текст в HTML, а не пустая SPA-оболочка.
 * Семь страниц × два языка = 14 файлов с одинаковой шапкой, подвалом,
 * hreflang и JSON-LD — руками такое расходится за неделю. Поэтому источник
 * один: site-content/site.json (общее) + site-content/pages/*.json (страницы,
 * оба языка рядом в каждом поле), а этот скрипт собирает из них HTML перед
 * `vite build` (см. package.json → "pages"). Сгенерированные файлы в git не
 * хранятся (.gitignore), правится только JSON.
 *
 * Экспортирует renderSite() — чистую функцию «контент → файлы», её же
 * проверяет tests/site/pages.test.ts. CLI-режим пишет файлы на диск.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(WEB_ROOT, "site-content");

const LANGS = ["ru", "tg"];
/** Пути, которые НЕ зеркалятся под /tg/ — приложения, а не страницы сайта. */
const APP_PATHS = ["/course", "/l/", "/panel", "/api", "/admin"];

// ---------- утилиты ----------

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Инлайн-SVG для круглых кнопок контактов/подвала (бриф п.12) — не эмодзи:
 * тем рисуются по-разному на каждой ОС и криво центруются в круге. Простые
 * контурные значки 24×24, цвет — currentColor, подхватывает .contact/.social. */
const ICONS = {
  map: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
  phone:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  whatsapp:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.04 2c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.4 1.26 4.83L2 22l5.35-1.28a9.9 9.9 0 0 0 4.69 1.19h.01c5.5 0 9.96-4.46 9.96-9.96S17.54 2 12.04 2zm0 18.1a8.1 8.1 0 0 1-4.13-1.13l-.3-.18-3.08.74.75-3.06-.2-.32a8.13 8.13 0 1 1 6.96 3.95zm4.46-6.07c-.24-.12-1.44-.71-1.66-.79-.22-.08-.39-.12-.55.12-.16.24-.63.79-.78.95-.14.16-.29.18-.53.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.11-.49.11-.11.24-.29.36-.43.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.42-.55-.42h-.47c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.7 2.6 4.13 3.64.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28z"/></svg>',
  telegram:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21.5 4.5 2.7 11.9c-1.28.52-1.27 1.24-.24 1.56l4.8 1.5 1.85 5.6c.22.6.4.85.8.85.33 0 .5-.15.72-.36l2.02-1.96 4.2 3.1c.77.43 1.32.2 1.52-.71l2.75-13.05c.3-1.12-.42-1.63-1.62-1.13zM8.7 14.3l9.1-5.75c.43-.27.82-.12.5.18l-7.6 6.9-.3 3.3-1.7-4.63z"/></svg>',
  instagram:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
  tiktok:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.6 2h-3.2v13.7a2.8 2.8 0 1 1-2-2.68V9.7a6 6 0 1 0 5.2 5.94V8.3a7.4 7.4 0 0 0 4.2 1.3V6.4a4.2 4.2 0 0 1-4.2-4.2z"/></svg>',
};

/** Двуязычное поле {ru, tg} → строка нужного языка; строки и массивы — как есть. */
function L(v, lang) {
  if (v && typeof v === "object" && !Array.isArray(v) && ("ru" in v || "tg" in v)) return v[lang] ?? v.ru ?? "";
  return v;
}

function isAppPath(href) {
  return APP_PATHS.some((p) => href === p || href.startsWith(p));
}

/** Внутренняя ссылка с учётом языка: /faq → /tg/faq на таджикской странице. */
export function localHref(href, lang) {
  if (!href.startsWith("/") || lang === "ru" || isAppPath(href)) return href;
  return href === "/" ? "/tg/" : `/tg${href}`;
}

/** Мини-markdown в абзацах: **жирный**, [текст](ссылка). Сначала экранируем. */
export function md(text, lang, ctx) {
  let out = esc(text);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    if (href === "chat:") return `<a href="${esc(ctx.wa)}" data-chat="${esc(ctx.ui.ctaBuyPrefill)}">${label}</a>`;
    const h = localHref(href, lang);
    const ext = /^https?:/i.test(h);
    return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  });
  return out;
}

function stripMd(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function pageUrl(site, slug, lang) {
  const base = lang === "ru" ? "" : "/tg";
  return `${site.origin}${base}/${slug}`;
}

function outFile(slug, lang) {
  if (lang === "ru") return slug ? `${slug}.html` : "site.html";
  return slug ? `tg/${slug}.html` : "tg/index.html";
}

function waLink(site, text) {
  return `${site.contacts.whatsapp}?text=${encodeURIComponent(text)}`;
}

// ---------- медиа (фото десертов/инструментов/иллюстрация Ширин) ----------
//
// site-content/media.json пишет параллельный агент; его может ещё не быть,
// либо в нём может не хватать части ключей — вся вёрстка ниже обязана
// работать и без него (текстовые списки, эмодзи-заглушки), поэтому здесь
// только безопасное чтение, без исключений наружу.

/** @returns {any|null} */
function loadMedia(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "media.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Картинка из media.json: <picture> с AVIF-источником (если конвейер
 * enhance-images его собрал) и <img> в webp с srcset/явными width/height —
 * без сдвига раскладки, с ленивой загрузкой. entry: {src, srcSm?, avif?,
 * avifSm?, width, height, alt}. opts.eager — для героя (LCP): fetchpriority=high
 * и без lazy. opts.sizes — атрибут sizes под конкретный слот (по умолчанию
 * половина экрана на ПК, весь экран на телефоне).
 */
function mediaImg(entry, alt, opts = {}) {
  if (!entry || !entry.src) return "";
  const { eager = false, cls = "", sizes = "(min-width: 720px) 480px, 100vw" } = opts;
  const w = entry.width || 800;
  const set = (full, sm) => (sm ? `${esc(sm)} ${Math.round(w / 2)}w, ${esc(full)} ${w}w` : "");
  const webpSet = set(entry.src, entry.srcSm);
  const srcset = webpSet ? ` srcset="${webpSet}" sizes="${esc(sizes)}"` : "";
  const loading = eager ? "" : ' loading="lazy" decoding="async"';
  const fetchpriority = eager ? ' fetchpriority="high"' : "";
  const img = `<img${cls ? ` class="${cls}"` : ""} src="${esc(entry.src)}"${srcset} width="${esc(w)}" height="${esc(
    entry.height || 1000,
  )}" alt="${esc(alt ?? entry.alt ?? "")}"${loading}${fetchpriority} />`;
  if (!entry.avif) return img;
  const avifSet = set(entry.avif, entry.avifSm) || `${esc(entry.avif)} ${w}w`;
  return `<picture><source type="image/avif" srcset="${avifSet}" sizes="${esc(sizes)}" />${img}</picture>`;
}

/** Абсолютный URL картинки превью ссылки: своя на страницу+язык, иначе общая. */
function ogImage(site, page, lang, media) {
  const own = media?.ogPages?.[page.slug]?.[lang];
  return { url: site.origin + (own ?? site.ogImage), custom: Boolean(own) };
}

// ---------- шапка / подвал ----------

function renderHeader(site, page, lang, ctx) {
  const ui = ctx.ui;
  const home = localHref("/", lang);
  const navLinks = (cls) =>
    site.nav
      .map((n) => {
        const cur = n.slug === page.slug ? ' aria-current="page"' : "";
        return `<a href="${localHref(`/${n.slug}`, lang)}"${cur}>${esc(L(n, lang))}</a>`;
      })
      .join("");
  const langSwitch = LANGS.map((l) => {
    const url = l === lang ? "" : pageUrl(site, page.slug, l);
    const label = l === "tg" ? "ТҶ" : "РУ";
    return l === lang
      ? `<span class="lang-pill on" aria-current="true" lang="${l}">${label}</span>`
      : `<a class="lang-pill" href="${esc(url)}" hreflang="${l}" lang="${l}" data-lang="${l}">${label}</a>`;
  }).join("");

  return `
<a class="skip-link" href="#main">${esc(ui.skip)}</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="${home}" aria-label="${esc(site.brand)} — ${esc(ui.home)}">
      <span class="logo-mark" aria-hidden="true">S</span>
      <span>${esc(site.brand)}<small>${esc(ui.tagline)}</small></span>
    </a>
    <nav class="site-nav" aria-label="${esc(ui.menu)}">${navLinks()}</nav>
    <div class="header-tools">
      <div class="lang-switch" role="group" aria-label="${esc(ui.langLabel)}">${langSwitch}</div>
      <a class="btn btn-ghost header-cta" href="/course">${esc(ui.ctaLessons)}</a>
      <a class="btn header-cta" href="${esc(ctx.wa)}" data-chat="${esc(ui.ctaBuyPrefill)}">${esc(ui.ctaBuy)}</a>
      <button type="button" class="menu-btn" data-menu-toggle aria-expanded="false" aria-controls="mobile-nav" aria-label="${esc(ui.menu)}">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="${esc(ui.menu)}" data-open="false">
    <div class="wrap">
      ${navLinks()}
      <a href="/course">${esc(ui.ctaLessons)}</a>
      <a href="${esc(ctx.wa)}" data-chat="${esc(ui.ctaBuyPrefill)}">${esc(ui.ctaBuy)}</a>
    </div>
  </nav>
</header>`;
}

function renderFooter(site, lang, ctx) {
  const ui = ctx.ui;
  const links = site.nav
    .map((n) => `<li><a href="${localHref(`/${n.slug}`, lang)}">${esc(L(n, lang))}</a></li>`)
    .join("");
  const year = ctx.now.getFullYear();
  return `
<footer class="site-footer">
  <div class="wrap">
    <div>
      <p><strong>${esc(site.brand)}</strong> · ${esc(ui.tagline)}</p>
      <p style="margin-top:8px;max-width:60ch">${esc(ui.footerAbout)}</p>
      <p class="footer-phone"><a href="tel:${esc(site.contacts.phone)}">${esc(site.contacts.phoneDisplay)}</a></p>
      ${site.contacts.address ? `<p class="footer-address"><a href="${esc(site.contacts.maps)}" target="_blank" rel="noopener">${esc(site.contacts.address[lang] || site.contacts.address.ru)}</a></p>` : ""}
      <ul class="social-row">
        <li><a class="social" href="${esc(site.contacts.whatsapp)}" rel="noopener" aria-label="WhatsApp">${ICONS.whatsapp}</a></li>
        <li><a class="social" href="${esc(site.contacts.telegram)}" rel="noopener" aria-label="Telegram">${ICONS.telegram}</a></li>
        <li><a class="social" href="${esc(site.contacts.instagram)}" rel="noopener" aria-label="Instagram">${ICONS.instagram}</a></li>
        <li><a class="social" href="${esc(site.contacts.tiktok)}" rel="noopener" aria-label="TikTok">${ICONS.tiktok}</a></li>
      </ul>
      <p style="margin-top:12px">© ${year} ${esc(ui.footerRights)} · <a href="/panel" rel="nofollow">${esc(ui.footerPanel)}</a></p>
    </div>
    <ul class="footer-links">${links}<li><a href="/course">${esc(ui.ctaLessons)}</a></li></ul>
  </div>
</footer>`;
}

// ---------- секции ----------

function ctaButtons(ctas, lang, ctx) {
  const ui = ctx.ui;
  return ctas
    .map((c) => {
      const cls = `btn btn-lg${c.ghost ? " btn-ghost" : ""}`;
      switch (c.kind) {
        case "chat":
          return `<a class="${cls}" href="${esc(ctx.wa)}" data-chat="${esc(ui.ctaBuyPrefill)}">${esc(L(c.label, lang) || ui.ctaBuy)}</a>`;
        case "lessons":
          return `<a class="${cls}" href="/course">${esc(L(c.label, lang) || ui.ctaLessons)}</a>`;
        case "whatsapp":
          return `<a class="${cls}" href="${esc(ctx.wa)}" rel="noopener">${esc(L(c.label, lang) || ui.ctaWhatsapp)}</a>`;
        default:
          return `<a class="${cls}" href="${esc(localHref(c.href, lang))}">${esc(L(c.label, lang))}</a>`;
      }
    })
    .join("");
}

function statsList(site, lang) {
  return `<ul class="stats">${site.stats
    .map((s) => `<li class="stat"><b>${esc(s.n)}</b><span>${esc(L(s, lang))}</span></li>`)
    .join("")}</ul>`;
}

function sectionHead(s, lang, extra = "") {
  const h2 = L(s.h2, lang);
  const lead = L(s.lead, lang);
  if (!h2 && !lead) return "";
  return `<div class="section-head">${h2 ? `<h2 class="h2">${esc(h2)}</h2>` : ""}${
    lead ? `<p class="lead">${esc(lead)}</p>` : ""
  }${extra}</div>`;
}

function moreLink(s, lang) {
  if (!s.href) return "";
  return `<p style="margin-top:20px"><a class="btn btn-soft" href="${esc(localHref(s.href, lang))}">${esc(L(s.linkLabel, lang))}</a></p>`;
}

// Строка доверия под кнопками героя — короткие бейджи-подтверждения, не
// маркетинговый текст из site-content (там таких фраз нет), поэтому строки
// зашиты здесь же, рядом с остальной вёрсткой шаблона, тем же способом, что
// и другие мелкие UI-подписи (см. notFound* выше). Первый бейдж берёт число
// из site.stats («выпускниц»), чтобы не дублировать цифру руками.
function trustRow(site, lang) {
  const grads = site.stats.find((s) => /выпускниц|хатм/i.test(s.ru + s.tg));
  const items = [
    grads ? { icon: "⭐", text: { ru: `${grads.n} ${L(grads, "ru")}`, tg: `${grads.n} ${L(grads, "tg")}` } } : null,
    { icon: "🏅", text: { ru: "сертификат", tg: "сертификат" } },
    { icon: "📱", text: { ru: "с телефона", tg: "аз телефон" } },
  ].filter(Boolean);
  return `<ul class="trust-row">${items
    .map((it) => `<li><span aria-hidden="true">${it.icon}</span>${esc(L(it.text, lang))}</li>`)
    .join("")}</ul>`;
}

/** Слот героя: до 860px — во всю ширину, дальше — колонка не шире 420px. */
const HERO_SIZES = "(min-width: 860px) 420px, 100vw";

/** Картинка героя: своя для страницы (media.heroPages[slug]), иначе общий
 *  коллаж media.hero, иначе первое фото десерта. */
function heroMedia(media, page) {
  if (page?.slug && media?.heroPages?.[page.slug]?.src) return media.heroPages[page.slug];
  if (media?.hero?.src) return media.hero;
  return (media?.desserts && Object.values(media.desserts)[0]) || null;
}

const SECTIONS = {
  hero(s, lang, ctx) {
    const { site, page, media } = ctx;
    // Герой-картинка (LCP): коллаж make-covers (media.hero), без него —
    // первая запись media.desserts. Без media.json просто нет .hero-photo —
    // раскладка герой-карточки (grid) одинаково работает и с фото, и без него.
    const heroEntry = heroMedia(media, page);
    const photo = heroEntry
      ? `<div class="hero-photo"><span class="hero-photo-glow" aria-hidden="true"></span>${mediaImg(
          heroEntry,
          L(heroEntry.alt, lang) || L(page.h1, lang),
          {
            eager: true,
            sizes: HERO_SIZES,
          },
        )}</div>`
      : "";
    return `<section class="hero"><div class="wrap"><div class="hero-grid${photo ? " has-photo" : ""}"><div class="hero-card">
      ${s.eyebrow ? `<span class="eyebrow">${esc(L(s.eyebrow, lang))}</span>` : ""}
      <h1 class="h1">${esc(L(page.h1, lang))}</h1>
      <p class="lead">${esc(L(s.lead, lang))}</p>
      <div class="btn-row">${ctaButtons(s.ctas ?? [], lang, ctx)}</div>
      ${trustRow(site, lang)}
    </div>${photo}</div>${s.stats ? statsList(site, lang) : ""}</div></section>`;
  },

  /**
   * Герой-«витрина» для лендинга одного курса: настоящее фото десерта на
   * весь экран (media.heroPages[slug]), крупный заголовок поверх, круглая
   * печать-бейдж (сертификат) и бегущая строка фактов снизу — приёмы
   * премиальных лендингов кондитерских брендов (см. референс дизайна от
   * владельца 06.09.2026), но в цветах и фото Ширин, не донора-референса.
   * Без фото ведёт себя как обычный hero (без photo-класса).
   */
  heroBold(s, lang, ctx) {
    const { site, page, media } = ctx;
    const heroEntry = heroMedia(media, page);
    const photo = heroEntry
      ? mediaImg(heroEntry, L(heroEntry.alt, lang) || L(page.h1, lang), {
          eager: true,
          cls: "hero-bold-img",
          sizes: "100vw",
        })
      : "";
    const stamp = s.stamp
      ? `<div class="hero-stamp" aria-hidden="true">
          <svg viewBox="0 0 120 120"><path id="stampCircle" fill="none" d="M60,60 m-46,0 a46,46 0 1,1 92,0 a46,46 0 1,1 -92,0"/>
            <text><textPath href="#stampCircle">${esc(L(s.stamp, lang))}</textPath></text>
          </svg>
          <span class="hero-stamp-core">${s.stampIcon ?? "🏅"}</span>
        </div>`
      : "";
    const ticker = s.ticker
      ? (() => {
          const items = L(s.ticker, lang)
            .map((t) => `<span>${esc(t)}</span>`)
            .join('<span class="dot">·</span>');
          // Дорожка удвоена подряд — при анимации translateX(-50%) стык
          // первой и второй копии незаметен, бегущая строка кажется бесконечной.
          return `<div class="hero-ticker" role="note"><div class="hero-ticker-track">${items}<span class="dot">·</span>${items}</div></div>`;
        })()
      : "";
    return `<section class="hero hero-bold${photo ? " has-photo" : ""}">
      <div class="hero-bold-media">${photo}<span class="hero-bold-scrim" aria-hidden="true"></span></div>
      <div class="hero-bold-overlay"><div class="wrap"><div class="hero-bold-card">
        ${s.eyebrow ? `<span class="eyebrow eyebrow-light">${esc(L(s.eyebrow, lang))}</span>` : ""}
        <h1 class="h1">${esc(L(page.h1, lang))}</h1>
        <p class="lead lead-light">${esc(L(s.lead, lang))}</p>
        <div class="btn-row">${ctaButtons(s.ctas ?? [], lang, ctx)}</div>
        ${trustRow(site, lang)}
      </div>${stamp}</div></div>
      ${ticker}
    </section>`;
  },

  formats(s, lang, ctx) {
    const items = s.items
      .map(
        (it) => `<article class="card feature">
        <span class="feature-icon" aria-hidden="true">${it.icon}</span>
        <div><h3 class="h3">${esc(L(it.title, lang))}</h3><p>${esc(L(it.text, lang))}</p>
        ${it.href ? `<p style="margin-top:10px"><a href="${esc(localHref(it.href, lang))}">${esc(L(it.linkLabel, lang))}</a></p>` : ""}</div>
      </article>`,
      )
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<div class="grid grid-2">${items}</div>`, ctx);
  },

  cards(s, lang, ctx) {
    const items = s.items
      .map(
        (it) => `<article class="card feature">
        <span class="feature-icon" aria-hidden="true">${it.icon}</span>
        <div><h3 class="h3">${esc(L(it.title, lang))}</h3><p>${esc(L(it.text, lang))}</p></div>
      </article>`,
      )
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<div class="grid grid-${Math.min(s.items.length, 3)}">${items}</div>`, ctx);
  },

  courses(s, lang, ctx) {
    const ui = ctx.ui;
    // Островок React. До загрузки JS (и для поисковика) — текст-заглушка и
    // рабочие кнопки на WhatsApp; цены здесь НЕ пишем — они только из API.
    const fallback = `<div class="card"><p>${esc(ui.coursesFallback)}</p>
      <div class="btn-row" style="margin-top:16px">
        <a class="btn" href="${esc(ctx.wa)}" data-chat="${esc(ui.ctaBuyPrefill)}">${esc(ui.ctaBuy)}</a>
        <a class="btn btn-ghost" href="/course">${esc(ui.ctaLessons)}</a>
      </div></div>`;
    const dataCourse = s.only ? ` data-course="${esc(s.only)}"` : "";
    return wrap(s, `${sectionHead(s, lang)}<div id="courses-island"${dataCourse}>${fallback}</div>`, ctx);
  },

  menu(s, lang, ctx) {
    const { site, media } = ctx;
    // Список десертов — свой у секции (s.items, например 6 уроков «Арт-
    // десертов», у которых нет ничего общего с общим списком «21 рецепта»),
    // иначе общий site.desserts (21 позиция офлайн-курса/«21 рецепта»).
    const desserts = s.items ?? site.desserts;
    // Фотокарусель, если есть media.desserts (ключ — русское имя десерта из
    // site.desserts); иначе — прежний текстовый список с эмодзи-иконками,
    // чтобы страница не ломалась, пока фото ещё не готовы. Десерты без фото
    // получают ту же карточку 4:5, только с эмодзи на кремовом фоне — ряд
    // остаётся ровным (см. .dessert-photo .ico в site.css).
    const photos = media?.desserts;
    const card = (d) => {
      const entry = photos?.[d.ru ?? L(d, "ru")];
      const img = entry ? mediaImg(entry, L(d, lang), { sizes: "(min-width: 720px) 180px, 42vw" }) : "";
      return `<figure class="dessert-photo">${img || `<span class="ico" aria-hidden="true">${d.icon}</span>`}<figcaption>${esc(
        L(d, lang),
      )}</figcaption></figure>`;
    };
    if (!photos) {
      const list = `<ul class="dessert-grid">${desserts
        .map((d) => `<li><span class="ico" aria-hidden="true">${d.icon}</span><span>${esc(L(d, lang))}</span></li>`)
        .join("")}</ul>`;
      return wrap(s, `${sectionHead(s, lang)}${list}`, ctx);
    }
    // mode:"list" (страница онлайн-курса) — вся карусель видна сразу, без
    // сворачивания: там это единственный список программы на странице.
    if (s.mode !== "accordion") {
      const body = `<div class="dessert-scroll">${desserts.map(card).join("")}</div>`;
      return wrap(s, `${sectionHead(s, lang)}${body}`, ctx);
    }
    // mode:"accordion" (главная) — карусель всегда видна (первые
    // PREVIEW_COUNT десертов); «показать все» не прячет карусель целиком, а
    // докручивает остальные карточки в сетку ниже. Так «показать все 21» из
    // контента остаётся дословным, а UX совпадает с брифом («карусель +
    // показать все → сетка»).
    const PREVIEW_COUNT = 6;
    const preview = desserts.slice(0, PREVIEW_COUNT).map(card).join("");
    const rest = desserts.slice(PREVIEW_COUNT).map(card).join("");
    const body = `<div class="dessert-scroll">${preview}</div>${
      rest
        ? `<div class="acc" style="margin-top:12px"><details><summary>${esc(
            L(s.summary, lang),
          )}</summary><div class="acc-body dessert-more">${rest}</div></details></div>`
        : ""
    }`;
    return wrap(s, `${sectionHead(s, lang)}${body}`, ctx);
  },

  /** Инструменты кондитера — карточки-фото из media.tools. Автодобавляется
   * на главной, если media.json существует (см. renderPage). */
  tools(_s, lang, ctx) {
    const { media, ui } = ctx;
    const items = media?.tools ?? [];
    if (items.length === 0) return "";
    const cards = items
      .map((t) => {
        const caption = L(t.caption, lang) || "";
        return `<figure class="card tool-card">${mediaImg(t, caption, { sizes: "(min-width: 1024px) 220px, 45vw" })}<figcaption>${esc(caption)}</figcaption></figure>`;
      })
      .join("");
    return wrap(
      { id: "tools" },
      `${sectionHead({ h2: ui.toolsTitle ?? { ru: "Инструменты", tg: "Асбобҳо" } }, lang)}<div class="grid tools-grid">${cards}</div>`,
      ctx,
    );
  },

  offline(s, lang, ctx) {
    const { site, ui } = ctx;
    const facts = `<ul class="facts">${s.facts
      .map((f) => `<li><span class="ico" aria-hidden="true">${f.icon}</span><span>${esc(L(f.text, lang))}</span></li>`)
      .join("")}</ul>`;
    const price = site.offline.price;
    const fallback = `<div class="card"><div class="price-tag">${price} ${lang === "tg" ? "сомонӣ" : "сомони"}<small>${esc(
      ui.priceIncluded,
    )}</small></div><p class="muted">${esc(ui.offlineFormFallback)}</p>
      <div class="btn-row" style="margin-top:16px"><a class="btn" href="${esc(ctx.wa)}" rel="noopener">${esc(ui.ctaWhatsapp)}</a>
      <a class="btn btn-ghost" href="${esc(site.contacts.telegram)}" rel="noopener">${esc(ui.ctaTelegram)}</a></div></div>`;
    return wrap(
      s,
      `${sectionHead(s, lang)}<div class="offline"><div class="card">${facts}${moreLink(s, lang)}</div>
      <div id="offline-form-island" data-price="${price}">${fallback}</div></div>`,
      ctx,
    );
  },

  certificate(s, lang, ctx) {
    const ps = L(s.paragraphs, lang)
      .map((p) => `<p>${md(p, lang, ctx)}</p>`)
      .join("");
    return wrap(
      s,
      `<div class="cert"><div class="cert-art" aria-hidden="true">🏅</div><div class="prose">${sectionHead(s, lang)}${ps}${moreLink(s, lang)}</div></div>`,
      ctx,
    );
  },

  reviews(s, lang, ctx) {
    const { site, ui } = ctx;
    const r = site.reviews;
    const cards = r.items
      .map(
        (it) => `<figure class="card review">
        ${r.placeholder ? `<span class="chip">${esc(ui.exampleBadge)}</span>` : ""}
        <div class="stars" aria-hidden="true">★★★★★</div>
        <blockquote>«${esc(L(it.text, lang))}»</blockquote>
        <figcaption><span class="avatar" aria-hidden="true">${esc(L(it.name, lang).slice(0, 1))}</span>
        <span class="review-who"><b>${esc(L(it.name, lang))}</b><span class="chip">${esc(L(it.city, lang))} · ${esc(L(it.format, lang))}</span></span></figcaption>
      </figure>`,
      )
      .join("");
    const note = r.placeholder ? `<p class="form-note" style="margin-top:14px">${esc(ui.reviewsNote)}</p>` : "";
    const link = s.noLink ? "" : moreLink({ href: "/otzyvy", linkLabel: ui.allReviews }, lang);
    return wrap(s, `${sectionHead(s, lang)}<div class="grid grid-3">${cards}</div>${note}${link}`, ctx);
  },

  about(s, lang, ctx) {
    const ps = L(s.paragraphs, lang)
      .map((p) => `<p>${md(p, lang, ctx)}</p>`)
      .join("");
    // Иллюстрация, не фото — так решил владелец. SVG предпочтительнее PNG
    // (векторный, не бликует на ретине); без media.json — эмодзи-заглушка.
    const shirin = ctx.media?.shirin;
    const figure = shirin?.svg
      ? `<img src="${esc(shirin.svg)}" alt="" loading="lazy" />`
      : shirin?.png
        ? `<img src="${esc(shirin.png)}" alt="" loading="lazy" />`
        : `<span class="emoji" aria-hidden="true">👩‍🍳</span>`;
    return wrap(
      s,
      `<div class="about"><div class="about-figure" role="img" aria-label="${esc(L(s.h2, lang))}">${figure}</div>
      <div class="prose">${sectionHead(s, lang)}${ps}${moreLink(s, lang)}</div></div>`,
      ctx,
    );
  },

  text(s, lang, ctx) {
    const ps = L(s.paragraphs, lang)
      .map((p) => `<p>${md(p, lang, ctx)}</p>`)
      .join("");
    return wrap(s, `<div class="card prose">${sectionHead(s, lang)}${ps}${moreLink(s, lang)}</div>`, ctx);
  },

  steps(s, lang, ctx) {
    const items = s.items
      .map((it) => `<li><div><b>${esc(L(it.title, lang))}</b><p>${md(L(it.text, lang), lang, ctx)}</p></div></li>`)
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<ol class="steps card">${items}</ol>`, ctx);
  },

  facts(s, lang, ctx) {
    const items = s.items
      .map((f) => `<li><span class="ico" aria-hidden="true">${f.icon}</span><span>${esc(L(f.text, lang))}</span></li>`)
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<ul class="facts card">${items}</ul>`, ctx);
  },

  stats(s, lang, ctx) {
    return wrap(s, `${sectionHead(s, lang)}${statsList(ctx.site, lang)}`, ctx);
  },

  faq(s, lang, ctx) {
    const items = s.items
      .map(
        (it) =>
          `<details><summary>${esc(L(it.q, lang))}</summary><div class="acc-body">${md(L(it.a, lang), lang, ctx)}</div></details>`,
      )
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<div class="acc">${items}</div>${moreLink(s, lang)}`, ctx);
  },

  contacts(s, lang, ctx) {
    const { site, ui } = ctx;
    const c = site.contacts;
    // Круглые кнопки с инлайн-SVG вместо эмодзи (бриф п.12) — эмодзи рисуются
    // по-разному на разных ОС и не всегда попадают в круг ровно по центру.
    const item = (href, icon, label, sub, ext = true) =>
      `<li><a class="contact" href="${esc(href)}"${ext ? ' rel="noopener"' : ""}><span class="ico" aria-hidden="true">${ICONS[icon]}</span><span>${esc(
        label,
      )}<small>${esc(sub)}</small></span></a></li>`;
    const list = `<ul class="contacts">
      ${item(`tel:${c.phone}`, "phone", ui.phone, c.phoneDisplay, false)}
      ${c.address ? item(c.maps, "map", lang === "tg" ? "Суроға" : "Адрес", c.address[lang] || c.address.ru) : ""}
      ${item(ctx.wa, "whatsapp", ui.whatsapp, c.phoneDisplay)}
      ${item(c.telegram, "telegram", ui.telegram, c.telegramHandle)}
      ${item(c.instagram, "instagram", ui.instagram, c.instagramHandle)}
      ${item(c.tiktok, "tiktok", ui.tiktok, c.instagramHandle)}
    </ul>`;
    return wrap(s, `${sectionHead({ ...s, lead: s.lead ?? ui.contactsLead }, lang)}${list}`, ctx);
  },

  cta(s, lang, ctx) {
    return wrap(
      s,
      `<div class="card card-soft cta-band"><h2 class="h2">${esc(L(s.h2, lang))}</h2><p class="lead">${md(
        L(s.text, lang),
        lang,
        ctx,
      )}</p><div class="btn-row">${ctaButtons(s.ctas ?? [], lang, ctx)}</div></div>`,
      ctx,
    );
  },
};

function wrap(s, inner, _ctx) {
  return `<section class="section"${s.id ? ` id="${esc(s.id)}"` : ""}><div class="wrap">${inner}</div></section>`;
}

// ---------- JSON-LD ----------

function ldOrganization(site, lang) {
  return {
    "@type": "Organization",
    "@id": `${site.origin}/#org`,
    name: lang === "tg" ? "Shirin Sweets — курси қаннодии Ширин" : "Shirin Sweets — кондитерский курс Ширин",
    alternateName: lang === "tg" ? "Кондитерский курс Ширин" : "Курси қаннодии Ширин",
    url: site.origin,
    logo: `${site.origin}${site.logo}`,
    telephone: site.contacts.phone,
    address: {
      "@type": "PostalAddress",
      streetAddress: site.contacts.street,
      addressLocality: "Душанбе",
      addressCountry: "TJ",
    },
    sameAs: [site.contacts.instagram, site.contacts.tiktok, site.contacts.telegram, site.contacts.facebook],
    founder: { "@type": "Person", "@id": `${site.origin}/#shirin`, name: "Ширин" },
  };
}

function ldPerson(site, lang) {
  return {
    "@type": "Person",
    "@id": `${site.origin}/#shirin`,
    name: "Ширин",
    jobTitle: lang === "tg" ? "Қаннод" : "Кондитер",
    worksFor: { "@id": `${site.origin}/#org` },
    url: pageUrl(site, "o-shirin", lang),
    sameAs: [site.contacts.instagram, site.contacts.tiktok, site.contacts.telegram],
  };
}

function ldCourse(site, page, lang, mode) {
  const url = pageUrl(site, page.slug, lang);
  const base = {
    "@type": "Course",
    "@id": `${url}#course`,
    name: L(page.h1, lang),
    description: L(page.description, lang),
    url,
    provider: { "@id": `${site.origin}/#org` },
    inLanguage: ["ru", "tg"],
    educationalCredentialAwarded: lang === "tg" ? "Сертификати Shirin Sweets" : "Сертификат Shirin Sweets",
  };
  if (mode === "online") {
    // Цена онлайн-курсов живёт в базе бота и меняется в панели, поэтому
    // offers здесь намеренно нет: устаревшая цена в разметке хуже её отсутствия.
    return {
      ...base,
      hasCourseInstance: { "@type": "CourseInstance", courseMode: "online", courseWorkload: "PT10H" },
    };
  }
  return {
    ...base,
    offers: {
      "@type": "Offer",
      price: site.offline.price,
      priceCurrency: site.offline.currency,
      availability: "https://schema.org/InStock",
      url,
    },
    hasCourseInstance: {
      "@type": "CourseInstance",
      courseMode: "onsite",
      location: {
        "@type": "Place",
        name: "Shirin Sweets",
        address: {
          "@type": "PostalAddress",
          streetAddress: site.contacts.street,
          addressLocality: "Душанбе",
          addressCountry: "TJ",
        },
      },
      courseSchedule: { "@type": "Schedule", repeatCount: site.offline.days, startTime: "14:00", endTime: "17:00" },
    },
  };
}

function ldFaq(page, lang) {
  const items = page.sections.filter((s) => s.type === "faq").flatMap((s) => s.items);
  if (items.length === 0) return null;
  return {
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: L(it.q, lang),
      acceptedAnswer: { "@type": "Answer", text: stripMd(L(it.a, lang)) },
    })),
  };
}

function ldBreadcrumb(site, page, lang, ui) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: ui.home, item: pageUrl(site, "", lang) },
      { "@type": "ListItem", position: 2, name: L(page.crumb, lang), item: pageUrl(site, page.slug, lang) },
    ],
  };
}

function buildJsonLd(site, page, lang, ui) {
  const graph = [ldOrganization(site, lang)];
  const kinds = new Set(page.jsonld ?? []);
  if (kinds.has("website")) {
    graph.push({
      "@type": "WebSite",
      "@id": `${site.origin}/#website`,
      url: site.origin,
      name: site.brand,
      inLanguage: ["ru", "tg"],
      publisher: { "@id": `${site.origin}/#org` },
    });
  }
  if (page.slug) graph.push(ldBreadcrumb(site, page, lang, ui));
  if (kinds.has("course-online")) graph.push(ldCourse(site, page, lang, "online"));
  if (kinds.has("course-offline")) graph.push(ldCourse(site, page, lang, "offline"));
  if (kinds.has("person")) graph.push(ldPerson(site, lang));
  if (kinds.has("faq")) {
    const faq = ldFaq(page, lang);
    if (faq) graph.push(faq);
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

// ---------- страница целиком ----------

function renderHead(site, page, lang, ctx) {
  const url = pageUrl(site, page.slug, lang);
  const title = L(page.title, lang);
  const desc = L(page.description, lang);
  const alts = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l}" href="${esc(pageUrl(site, page.slug, l))}" />`,
  ).join("\n    ");
  const ld = JSON.stringify(buildJsonLd(site, page, lang, ctx.ui)).replace(/</g, "\\u003c");
  // Montserrat — display-шрифт для заголовков и цен: subset cyrillic-ext
  // покрывает таджикские буквы ғ ққ ҳ ҷ ӯ (Inter грузится тем же <link>,
  // одним запросом, чтобы не плодить preconnect-соединения).
  const fonts =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Montserrat:wght@700;800&display=swap&subset=cyrillic-ext";
  // Прелоад герой-фото на главной — это LCP-элемент, браузер должен начать
  // качать его до разбора CSS, а не после первого рендера <img>.
  // imagesrcset/imagesizes — чтобы прелоад совпал с тем, что выберет <img>
  // (иначе браузер скачает и прелоад, и другой кандидат). Все герой-страницы
  // (главная, курсы, FAQ…) начинаются с секции hero — прелоадим на каждой.
  const heroEntry = page.sections[0]?.type === "hero" ? heroMedia(ctx.media) : null;
  const heroPreload = heroEntry
    ? `<link rel="preload" as="image" href="${esc(heroEntry.src)}"${
        heroEntry.srcSm
          ? ` imagesrcset="${esc(heroEntry.srcSm)} ${Math.round((heroEntry.width || 800) / 2)}w, ${esc(heroEntry.src)} ${heroEntry.width || 800}w" imagesizes="${HERO_SIZES}"`
          : ""
      } fetchpriority="high" />`
    : "";
  const og = ogImage(site, page, lang, ctx.media);
  return `<meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="${site.themeColor}" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    ${page.noindex ? '<meta name="robots" content="noindex, follow" />' : ""}
    <link rel="canonical" href="${esc(url)}" />
    ${alts}
    <link rel="alternate" hreflang="x-default" href="${esc(pageUrl(site, page.slug, "ru"))}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${esc(site.brand)}" />
    <meta property="og:locale" content="${lang === "tg" ? "tg_TJ" : "ru_RU"}" />
    <meta property="og:locale:alternate" content="${lang === "tg" ? "ru_RU" : "tg_TJ"}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:image" content="${esc(og.url)}" />
    ${og.custom ? '<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />' : ""}
    <meta name="twitter:card" content="${og.custom ? "summary_large_image" : "summary"}" />
    <meta name="twitter:image" content="${esc(og.url)}" />
    <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
    <!-- Inter не блокирует отрисовку: подключаем как print, после загрузки
         переключаем на all. Системный шрифт виден сразу (display=swap). -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${fonts}" media="print" onload="this.media='all'" />
    <noscript><link rel="stylesheet" href="${fonts}" /></noscript>
    ${heroPreload}
    <script type="application/ld+json">${ld}</script>`;
}

export function renderPage(site, page, lang, now = new Date(), media = null) {
  const ui = site.ui[lang];
  const ctx = { site, page, ui, now, media, wa: waLink(site, L(page.waText, lang) || ui.ctaBuyPrefill) };
  let pageSections = page.sections;
  // Секция «Инструменты» из media.tools автогенерируется на главной сразу
  // после первой из «Что входит» (cards) / «Офлайн-курс» (offline) —
  // контент-агент про media.json может не знать, поэтому явно её в JSON не
  // пишет. Ищем «cards», иначе «offline» (реальный порядок секций на
  // главной — см. site-content/pages/home.json), иначе — в конец страницы.
  if (!page.slug && media?.tools?.length) {
    const anchorIdx = pageSections.findIndex((s) => s.type === "cards" || s.type === "offline");
    const toolsSection = { type: "tools", id: "tools" };
    pageSections =
      anchorIdx === -1
        ? [...pageSections, toolsSection]
        : [...pageSections.slice(0, anchorIdx + 1), toolsSection, ...pageSections.slice(anchorIdx + 1)];
  }
  const sections = pageSections.map((s) => {
    const fn = SECTIONS[s.type];
    if (!fn) throw new Error(`Unknown section type "${s.type}" on page "${page.slug}"`);
    return fn(s, lang, ctx);
  });
  const hasHero = page.sections[0]?.type === "hero" || page.sections[0]?.type === "heroBold";
  const crumbs = page.slug
    ? `<div class="wrap"><ol class="crumbs" aria-label="breadcrumb"><li><a href="${localHref("/", lang)}">${esc(ui.home)}</a></li><li aria-current="page">${esc(
        L(page.crumb, lang),
      )}</li></ol></div>`
    : "";
  const h1 = hasHero
    ? ""
    : `<div class="wrap" style="padding-top:24px"><h1 class="h1">${esc(L(page.h1, lang))}</h1></div>`;

  return `<!doctype html>
<html lang="${lang}">
  <head>
    ${renderHead(site, page, lang, ctx)}
  </head>
  <body>
    ${renderHeader(site, page, lang, ctx)}
    <main id="main">
      ${crumbs}${h1}
      ${sections.join("\n")}
    </main>
    ${renderFooter(site, lang, ctx)}
    ${renderStickyCta(site, ui, ctx)}
    <script type="module" src="/src/site/main.tsx"></script>
  </body>
</html>
`;
}

/**
 * Липучая нижняя панель CTA — только на мобильном (см. CSS: скрыта от 720px).
 * Прячется, когда чат открыт: тот агент выставляет data-chat-open="1" на
 * <html>, здесь просто CSS-селектор [data-chat-open="1"] .sticky-cta —
 * никакой связи кода, только общий атрибут-контракт.
 */
function renderStickyCta(site, ui, ctx) {
  return `<div class="sticky-cta" role="region" aria-label="${esc(ui.ctaBuy)}">
    <a class="btn btn-lg" href="${esc(ctx.wa)}" data-chat="${esc(ui.ctaBuyPrefill)}">${esc(ui.ctaBuy)}</a>
    <a class="btn btn-lg btn-ghost" href="${esc(site.contacts.whatsapp)}" rel="noopener">${esc(ui.ctaWhatsapp)}</a>
  </div>`;
}

function renderNotFound(site, pages, now) {
  const page = {
    slug: "404",
    noindex: true,
    crumb: { ru: "404", tg: "404" },
    title: { ru: "Страница не найдена | Shirin Sweets", tg: "Саҳифа ёфт нашуд | Shirin Sweets" },
    description: { ru: "Такой страницы нет.", tg: "Чунин саҳифа нест." },
    h1: { ru: site.ui.ru.notFoundTitle, tg: site.ui.tg.notFoundTitle },
    waText: { ru: "Здравствуйте!", tg: "Ассалому алейкум!" },
    sections: [
      {
        type: "cta",
        h2: { ru: site.ui.ru.notFoundTitle, tg: site.ui.tg.notFoundTitle },
        text: { ru: `${site.ui.ru.notFoundText} [Тоҷикӣ →](/tg/)`, tg: site.ui.tg.notFoundText },
        ctas: [
          { kind: "link", href: "/", label: { ru: site.ui.ru.home, tg: site.ui.tg.home } },
          {
            kind: "link",
            href: "/online-kurs",
            ghost: true,
            label: pages.find((p) => p.slug === "online-kurs")?.crumb,
          },
          {
            kind: "link",
            href: "/kursy-konditera-dushanbe",
            ghost: true,
            label: pages.find((p) => p.slug === "kursy-konditera-dushanbe")?.crumb,
          },
        ],
      },
    ],
  };
  return renderPage(site, page, "ru", now);
}

function renderSitemap(site, pages, now) {
  const lastmod = now.toISOString().slice(0, 10);
  const urls = pages.flatMap((p) =>
    LANGS.map((lang) => {
      const alts = [...LANGS.map((l) => [l, pageUrl(site, p.slug, l)]), ["x-default", pageUrl(site, p.slug, "ru")]]
        .map(([l, href]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(href)}" />`)
        .join("\n");
      return `  <url>\n    <loc>${esc(pageUrl(site, p.slug, lang))}</loc>\n    <lastmod>${lastmod}</lastmod>\n${alts}\n  </url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

function renderRobots(site) {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /course
Disallow: /l/
Disallow: /panel
Disallow: /*?utm_
Sitemap: ${site.origin}/sitemap.xml
`;
}

// ---------- сборка ----------

export function loadContent(dir = CONTENT_DIR) {
  const site = JSON.parse(fs.readFileSync(path.join(dir, "site.json"), "utf8"));
  const media = loadMedia(dir);
  const pagesDir = path.join(dir, "pages");
  const pages = fs
    .readdirSync(pagesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(pagesDir, f), "utf8")));
  // Главная первой, остальные — в порядке меню, потом прочие.
  const order = ["", ...site.nav.map((n) => n.slug)];
  pages.sort((a, b) => {
    const ia = order.indexOf(a.slug);
    const ib = order.indexOf(b.slug);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return { site, pages, media };
}

/** Чистая сборка: контент → Map<относительный путь от apps/web, содержимое>. */
export function renderSite({ site, pages, media = null }, now = new Date()) {
  const files = new Map();
  for (const page of pages) {
    for (const lang of LANGS) files.set(outFile(page.slug, lang), renderPage(site, page, lang, now, media));
  }
  files.set("404.html", renderNotFound(site, pages, now));
  files.set("public/sitemap.xml", renderSitemap(site, pages, now));
  files.set("public/robots.txt", renderRobots(site));
  return files;
}

/** Имена HTML-входов для Vite (относительно apps/web). */
export function siteHtmlInputs(content = loadContent()) {
  return [...renderSite(content).keys()].filter((f) => f.endsWith(".html"));
}

function main() {
  const content = loadContent();
  const files = renderSite(content);
  for (const [rel, body] of files) {
    const abs = path.join(WEB_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
  console.log(
    `site pages: ${files.size} files written (${content.pages.length} pages × ${LANGS.length} langs + 404, sitemap, robots)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
