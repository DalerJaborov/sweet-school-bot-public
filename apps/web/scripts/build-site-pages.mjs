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

const LANGS = ["tg", "ru"];
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

// ---------- факты очного курса: {{offline.*}} → Nginx SSI ----------

/**
 * ЦЕНА, ЧАСЫ, ДНИ И ДЕСЕРТЫ ОЧНОГО КУРСА — ИЗ ПАНЕЛИ, А НЕ ИЗ ТЕКСТА (08.11.2026).
 *
 * В текстах страниц пишется {{offline.price}}, {{offline.hours}} и т. п.
 * Сборка превращает каждую подстановку в SSI-вставку: Nginx при отдаче
 * страницы спрашивает API (/_site/offer-fact) и вставляет значение, которое
 * владелец сохранил в «Цены и даты». Запасное значение (site.json → offline,
 * сторож сверяет его с умолчаниями бота) стоит в блоке прямо перед вставкой:
 * его видит статический предпросмотр и показывает Nginx, если API не ответил.
 * Кавычки одинарные — вставка может оказаться внутри атрибута и JSON-LD.
 */
const OFFER_TOKEN = /\{\{(offline\.(?:price|days|daysRu|desserts|dessertsRu|timeFrom|timeTo|hours)|contact\.(?:address|street|mapsQuery))\}\}/g;

/** Запасное «8 дней» / «21 десерт» — та же грамматика, что у API (offlineFacts.pluralRu). */
function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
const OFFER_INCLUDE = "<!--# include virtual='/_site/offer-fact?key=";

/** Адрес без города — для JSON-LD (город там отдельным полем); как offlineFacts.streetAddress. */
function streetOf(address) {
  return String(address).replace(/^\s*Душанбе\s*,\s*/u, "").trim() || address;
}

export function offerFallback(site, key, lang = "ru") {
  // Адрес очного курса (08.11.2026): то же поле панели, что у бота; запасное —
  // site.json → contacts.address. Экранирование — под место вставки.
  const address = site.contacts.address?.[lang] || site.contacts.address?.ru;
  if (key === "contact.address") return esc(address);
  if (key === "contact.street") return JSON.stringify(streetOf(address)).slice(1, -1).replace(/</g, "\\u003c").replace(/'/g, "\\u0027");
  if (key === "contact.mapsQuery") return encodeURIComponent(site.contacts.address.ru);
  const [from, to] = String(site.offline.hours).split("–");
  const value = {
    "offline.price": site.offline.price,
    "offline.days": site.offline.days,
    "offline.daysRu": `${site.offline.days} ${pluralRu(site.offline.days, "день", "дня", "дней")}`,
    "offline.desserts": site.offline.desserts,
    "offline.dessertsRu": `${site.offline.desserts} ${pluralRu(site.offline.desserts, "десерт", "десерта", "десертов")}`,
    "offline.timeFrom": from,
    "offline.timeTo": to,
    "offline.hours": site.offline.hours,
  }[key];
  if (value === undefined || value === "") throw new Error(`site.json offline has no fallback for {{${key}}}`);
  return esc(value);
}

export function applyOfferFacts(html, site, lang = "ru") {
  let n = 0;
  return html.replace(OFFER_TOKEN, (_m, key) => {
    const name = `offer${++n}`;
    const query = key.startsWith("contact.") ? `${key}&lang=${lang}` : key;
    return `<!--# block name='${name}' -->${offerFallback(site, key, lang)}<!--# endblock -->${OFFER_INCLUDE}${query}' stub='${name}' -->`;
  });
}

/** Страница с такими вставками должна отдаваться Nginx с `ssi on` (тест сверяет nginx.conf). */
export function usesOfferFacts(html) {
  return html.includes(OFFER_INCLUDE);
}

/** Что увидит человек без SSI (предпросмотр, проверка SEO): запасные значения. */
export function resolveSsiFallback(html) {
  return html.replace(/<!--# block name='(\w+)' -->([\s\S]*?)<!--# endblock --><!--# include [^>]*?-->/g, "$2");
}

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
  if (href === "/") return lang === "tg" ? "/" : "/ru/";
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
  if (slug === "404") return `${site.origin}/404`;
  if (!slug) return `${site.origin}${lang === "tg" ? "/" : "/ru/"}`;
  const base = lang === "ru" ? "" : "/tg";
  return `${site.origin}${base}/${slug}`;
}

function outFile(slug, lang) {
  if (!slug) return lang === "tg" ? "site.html" : "ru/index.html";
  if (lang === "ru") return `${slug}.html`;
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
  return { url: site.origin + (own ?? site.ogImage) + "?v=20261109-logo", custom: Boolean(own) };
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
    const url = l === lang ? "" : pageUrl(site, page.slug === "404" ? "" : page.slug, l);
    const label = l === "tg" ? "Тоҷикӣ" : "Русский";
    return l === lang
      ? `<span class="lang-pill on" aria-current="true" lang="${l}">${label}</span>`
      : `<a class="lang-pill" href="${esc(url)}" hreflang="${l}" lang="${l}" data-lang="${l}">${label}</a>`;
  }).join("");

  return `
<a class="skip-link" href="#main">${esc(ui.skip)}</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="${home}" aria-label="${esc(site.brand)} — ${esc(ui.home)}">
      <span class="logo-word" aria-hidden="true"></span>
    </a>
    <nav class="site-nav" aria-label="${esc(ui.menu)}">${navLinks()}</nav>
    <div class="header-tools">
      <button type="button" class="theme-toggle" data-theme-toggle aria-label="${lang === 'tg' ? 'Мавзӯи торик' : 'Тёмная тема'}" aria-pressed="false"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg></button>
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
      <img class="footer-logo" src="/img/brand/shirin-logo.svg?v=20261109-logo" width="112" height="112" alt="Shirin — сладкий мир" loading="lazy" decoding="async" />
      <p><strong>${esc(site.brand)}</strong> · ${esc(ui.tagline)}</p>
      <p style="margin-top:8px;max-width:60ch">${esc(ui.footerAbout)}</p>
      <p class="footer-phone"><a href="tel:${esc(site.contacts.phone)}">${esc(site.contacts.phoneDisplay)}</a></p>
      ${site.contacts.address ? `<p class="footer-address"><a href="https://maps.google.com/?q={{contact.mapsQuery}}" target="_blank" rel="noopener">{{contact.address}}</a></p>` : ""}
      <ul class="social-row">
        <li><a class="social" href="${esc(site.contacts.whatsapp)}" rel="noopener" aria-label="WhatsApp">${ICONS.whatsapp}</a></li>
        <li><a class="social" href="${esc(site.contacts.telegram)}" rel="noopener" aria-label="Telegram">${ICONS.telegram}</a></li>
        <li><a class="social" href="${esc(site.contacts.instagram)}" rel="noopener" aria-label="Instagram">${ICONS.instagram}</a></li>
        <li><a class="social" href="${esc(site.contacts.tiktok)}" rel="noopener" aria-label="TikTok">${ICONS.tiktok}</a></li>
      </ul>
      <p style="margin-top:12px">© ${year} ${esc(ui.footerRights)}</p>
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
function trustRow(site, lang, { phone = true } = {}) {
  const grads = site.stats.find((s) => /выпускниц|хатм/i.test(s.ru + s.tg));
  const items = [
    grads ? { icon: "⭐", text: { ru: `${grads.n} ${L(grads, "ru")}`, tg: `${grads.n} ${L(grads, "tg")}` } } : null,
    { icon: "🏅", text: { ru: "сертификат", tg: "сертификат" } },
    phone ? { icon: "📱", text: { ru: "с телефона", tg: "аз телефон" } } : null,
  ].filter(Boolean);
  return `<ul class="trust-row">${items
    .map((it) => `<li><span aria-hidden="true">${contentIcon(it.icon)}</span>${esc(L(it.text, lang))}</li>`)
    .join("")}</ul>`;
}

/** Слот героя: до 860px — во всю ширину, дальше — колонка не шире 420px. */
const HERO_SIZES = "(min-width: 860px) 420px, 100vw";

/** Картинка героя: своя для страницы (media.heroPages[slug]), иначе общий
 *  коллаж media.hero, иначе первое фото десерта. */
function heroMedia(media, page) {
  if (page?.slug && media?.heroPages?.[page.slug]?.src) return media.heroPages[page.slug];
  if (media?.desserts?.["Чизкейк «Дубайский шоколад»"]) return media.desserts["Чизкейк «Дубайский шоколад»"];
  if (media?.hero?.src) return media.hero;
  return (media?.desserts && Object.values(media.desserts)[0]) || null;
}


/** Фото для быстрой смены в герое (после основного LCP-кадра): только реальные десерты школы, крупные. */
const HERO_SLIDE_NAMES = ["Клубника в шоколаде", "Пирожное «Рафаэлло»", "Шоколадный торт", "Пирожное «Шу»"];
function heroExtraSlides(media, first) {
  return HERO_SLIDE_NAMES.map((n) => media?.desserts?.[n]).filter((e) => e?.src && e.src !== first?.src);
}

// Shared outline vocabulary for decorative content; source copy remains intact.
function contentIcon(symbol) {
  const paths = {
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    award: '<circle cx="12" cy="8" r="5"/><path d="m8 12-2 10 6-3 6 3-2-10"/>',
    home: '<path d="m3 10 9-7 9 7v11H3V10Z M9 21v-8h6v8"/>',
    book: '<path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v16h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3V4Z M12 6v16"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chat: '<path d="M3 4h18v13H9l-6 4V4Z"/>',
    cake: '<path d="M3 11h18v10H3V11Z M6 11V7h12v4 M9 7V3m6 4V3 M3 15c3 3 5-3 9 0s6-3 9 0"/>',
  };
  const kind = /📱|🎬/.test(symbol) ? 'phone' : /🏅|🎓/.test(symbol) ? 'award' : /🏠|🏡|🗺|📍/.test(symbol) ? 'home' : /💬|📩/.test(symbol) ? 'chat' : /📖|📚/.test(symbol) ? 'book' : /✓|✅|♾/.test(symbol) ? 'check' : 'cake';
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
}

const SECTIONS = {
  hero(s, lang, ctx) {
    const { site, page, media } = ctx;
    // Герой-картинка (LCP): коллаж make-covers (media.hero), без него —
    // первая запись media.desserts. Без media.json просто нет .hero-photo —
    // раскладка герой-карточки (grid) одинаково работает и с фото, и без него.
    const heroEntry = s.compact ? null : heroMedia(media, page);
    // Слайдшоу: первый кадр — LCP (eager, прелоад); остальные lazy и кроссфейдятся чистым CSS
    // (без JS, без сдвига раскладки: слот имеет фиксированное соотношение сторон).
    const extras = heroEntry && !s.video ? heroExtraSlides(media, heroEntry) : [];
    // Фоновое видео-петля (s.video): поверх постера в том же слоте 4:5. Без JS и до
    // первого кадра видео прозрачно — виден постер; JS (main.tsx) включает видео
    // классом is-playing и убирает его при «меньше анимации» и экономии трафика.
    const video = heroEntry && s.video
      ? `<video class="hero-video" src="${esc(s.video)}" autoplay muted loop playsinline preload="metadata" disablepictureinpicture aria-hidden="true" tabindex="-1" data-hero-video></video>`
      : "";
    const photo = heroEntry
      ? `<div class="hero-photo${extras.length ? " hero-slides" : ""}${video ? " has-video" : ""}" ${extras.length ? `data-slides="${extras.length + 1}" style="--slides:${extras.length + 1}"` : ""}>${video}${mediaImg(
          heroEntry,
          L(heroEntry.alt, lang) || L(page.h1, lang),
          {
            eager: true,
            sizes: HERO_SIZES,
            cls: extras.length ? "hero-slide" : "",
          },
        )}${extras
          .map((e, i) => `<span class="hero-slide-wrap" style="--i:${i + 1}" aria-hidden="true">${mediaImg(e, "", { sizes: HERO_SIZES, cls: "hero-slide" })}</span>`)
          .join("")}</div>`
      : "";
    return `<section class="hero${s.compact ? " hero-compact" : ""}"><div class="wrap"><div class="hero-grid${photo ? " has-photo" : ""}"><div class="hero-card">

      <h1 class="h1">${esc(L(page.h1, lang))}</h1>
      <p class="lead">${esc(L(s.lead, lang))}</p>
      <div class="btn-row">${ctaButtons(s.ctas ?? [], lang, ctx)}</div>
      ${trustRow(site, lang, { phone: page.slug !== "kursy-konditera-dushanbe" })}
    </div>${photo}</div>${s.stats ? statsList(site, lang) : ""}</div></section>${!page.slug || page.slug === "online-kurs" ? '<div class="wrap" id="free-lesson-island"></div>' : ""}`;
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
    return SECTIONS.hero(s, lang, ctx);
  },

  formats(s, lang, ctx) {
    const items = s.items
      .map(
        (it) => `<article class="card feature">
        <span class="feature-icon" aria-hidden="true">${contentIcon(it.icon)}</span>
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
        <span class="feature-icon" aria-hidden="true">${contentIcon(it.icon)}</span>
        <div><h3 class="h3">${esc(L(it.title, lang))}</h3><p>${esc(L(it.text, lang))}</p></div>
      </article>`,
      )
      .join("");
    return wrap(s, `${sectionHead(s, lang)}<div class="grid grid-${Math.min(s.items.length, 3)}">${items}</div>`, ctx);
  },

  courses(s, lang, ctx) {
    const ui = ctx.ui;
    // Nginx inserts the current public catalogue before sending HTML, so
    // visitors and crawlers see the same prices without a JavaScript fetch.
    // Static previews and failed subrequests retain a price-free fallback.
    const fallback = `<div class="card"><p>${esc(ui.coursesFallback)}</p>
      <div class="btn-row" style="margin-top:16px">
        <a class="btn" href="${esc(ctx.wa)}">${esc(ui.ctaBuy)}</a>
        <a class="btn btn-ghost" href="/course">${esc(ui.ctaLessons)}</a>
      </div></div>`;
    const dataCourse = s.only ? ` data-course="${esc(s.only)}"` : "";
    const query = `lang=${lang}${s.only ? `&only=${encodeURIComponent(s.only)}` : ""}`;
    const include = `<!--# block name="catalog-fallback" -->${fallback}<!--# endblock -->` +
      `<!--# include virtual="/_site/catalog-fragment?${query}" stub="catalog-fallback" -->`;
    return wrap(s, `${sectionHead(s, lang)}<div id="courses-island"${dataCourse}>${include}</div>`, ctx);
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
      return `<figure class="dessert-photo">${img || `<span class="ico" aria-hidden="true">${contentIcon(d.icon)}</span>`}<figcaption>${esc(
        L(d, lang),
      )}</figcaption></figure>`;
    };
    if (!photos) {
      const list = `<ul class="dessert-grid">${desserts
        .map((d) => `<li><span class="ico" aria-hidden="true">${contentIcon(d.icon)}</span><span>${esc(L(d, lang))}</span></li>`)
        .join("")}</ul>`;
      return wrap(s, `${sectionHead(s, lang)}${list}`, ctx);
    }
    // mode:"list" (страница онлайн-курса) — вся карусель видна сразу, без
    // сворачивания: там это единственный список программы на странице.
    if (s.mode !== "accordion") {
      // Все десерты сеткой сразу (без горизонтальной прокрутки, где на телефоне видно 2 из 21).
      // Названия десертов не переводим: и в таджикской версии — русские, как в самом курсе.
      // Реальное фото берём из media.desserts, затем из фото уроков (lessonSamples); нет фото —
      // плитка с названием, пустых серых квадратов нет.
      const lessonPhoto = (ru) => (media?.lessonSamples ?? []).find((x) => x.title?.ru === ru)?.image;
      const tile = (d) => {
        const ru = d.ru ?? L(d, "ru");
        const entry = photos?.[ru] ?? media?.artLessons?.[ru] ?? lessonPhoto(ru);
        const img = entry ? mediaImg(entry, ru, { sizes: "(min-width: 720px) 180px, 31vw" }) : "";
        return img
          ? `<figure class="dessert-photo">${img}<figcaption>${esc(ru)}</figcaption></figure>`
          : `<figure class="dessert-photo dessert-name"><span class="ico"><span aria-hidden="true">${contentIcon(d.icon)}</span><b>${esc(ru)}</b></span></figure>`;
      };
      // s.ctas — кнопка покупки сразу под сеткой: человек только что увидел десерты, самый тёплый момент.
      const body = `<div class="dessert-all${desserts.length <= 12 ? " is-big" : ""}">${desserts.map(tile).join("")}</div>${s.ctas ? `<div class="btn-row section-cta">${ctaButtons(s.ctas, lang, ctx)}</div>` : ""}`;
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
  lessonSamples(s, lang, ctx) {
    const only = ctx.page.slug === "art-desserty" ? "COURSE50" : "COURSE70";
    const items = (ctx.media?.lessonSamples ?? []).filter((item) => item.course === only);
    if (!items.length) return "";
    return wrap(s, `${sectionHead({h2: {ru: "Десерты из наших уроков", tg: "Шириниҳо аз дарсҳои мо"}}, lang)}<div class="lesson-samples">${items.map((item) => `<figure>${item.video ? `<video controls playsinline preload="none" poster="${esc(item.image.src)}" width="${item.image.width}" height="${item.image.height}" aria-label="${esc(L(item.title, lang))}"><source src="${esc(item.video)}" type="video/mp4"></video>` : mediaImg(item.image, L(item.title, lang), {sizes: "(min-width: 720px) 280px, 45vw"})}<figcaption>${esc(L(item.title, lang))}</figcaption></figure>`).join("")}</div>`, ctx);
  },

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
    const programme = ctx.offlineProgramme;
    const syllabus = programme ? `<details class="course-syllabus"><summary>${esc(L(programme.h2, lang))}</summary>${L(programme.paragraphs, lang).map((text) => `<p>${esc(text)}</p>`).join("")}</details>` : "";
    const facts = `<ul class="facts">${s.facts
      .map((f) => `<li><span class="ico" aria-hidden="true">${contentIcon(f.icon)}</span><span>${esc(L(f.text, lang))}</span></li>`)
      .join("")}</ul>`;
    const price = "{{offline.price}}";
    const fallback = `<div class="card"><div class="price-tag">${price} ${lang === "tg" ? "сомонӣ" : "сомони"}<small>${esc(
      ui.priceIncluded,
    )}</small></div><p class="muted">${esc(ui.offlineFormFallback)}</p>
      <div class="btn-row" style="margin-top:16px"><a class="btn" href="${esc(ctx.wa)}" rel="noopener">${esc(ui.ctaWhatsapp)}</a>
      <a class="btn btn-ghost" href="${esc(site.contacts.telegram)}" rel="noopener">${esc(ui.ctaTelegram)}</a></div></div>`;
    return wrap(
      s,
      `${sectionHead(s, lang)}<div class="offline"><div class="card">${facts}${syllabus}${moreLink(s, lang)}</div>
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
      `<div class="cert"><div class="cert-art" aria-hidden="true">${contentIcon("🏅")}</div><div class="prose">${sectionHead(s, lang)}${ps}${moreLink(s, lang)}</div></div>`,
      ctx,
    );
  },

  reviews(s, lang, ctx) {
    const { site, ui } = ctx;
    const r = site.reviews;
    if (r.placeholder) {
      const text = lang === "tg"
        ? "Корҳои Ширин ва нашрияҳоро дар саҳифаи расмии Instagram бинед. Пеш аз харид метавонед ба Ширин савол диҳед."
        : "Посмотрите работы Ширин и публикации на официальной странице Instagram. Перед покупкой можно задать Ширин вопросы о курсе.";
      return wrap(s, `${sectionHead(s, lang)}<div class="card prose"><p>${esc(text)}</p><p><a class="btn btn-soft" href="${esc(site.contacts.instagram)}" target="_blank" rel="noopener">Instagram · ${esc(site.contacts.instagramHandle)}</a></p></div>`, ctx);
    }
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
        : `<span class="emoji" aria-hidden="true">${contentIcon("📖")}</span>`;
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
      .map((f) => `<li><span class="ico" aria-hidden="true">${contentIcon(f.icon)}</span><span>${esc(L(f.text, lang))}</span></li>`)
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
      ${c.address ? item("https://maps.google.com/?q={{contact.mapsQuery}}", "map", lang === "tg" ? "Суроға" : "Адрес", "{{contact.address}}") : ""}
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
      )}</p><div class="btn-row">${ctaButtons(s.ctas ?? [], lang, ctx)}</div>${
        ["online-kurs", "art-desserty"].includes(ctx.page.slug) ? trustRow(ctx.site, lang) : ""
      }</div>`,
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
      streetAddress: "{{contact.street}}",
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
    inLanguage: "tg",
    educationalCredentialAwarded: lang === "tg" ? "Сертификати Shirin Sweets" : "Сертификат Shirin Sweets",
  };
  if (mode === "online") {
    // Цена онлайн-курсов живёт в базе бота и меняется в панели, поэтому
    // offers здесь намеренно нет: устаревшая цена в разметке хуже её отсутствия.
    return {
      ...base,
      hasCourseInstance: { "@type": "CourseInstance", courseMode: "online" },
    };
  }
  return {
    ...base,
    hasCourseInstance: {
      "@type": "CourseInstance",
      courseMode: "onsite",
      location: {
        "@type": "Place",
        name: "Shirin Sweets",
        address: {
          "@type": "PostalAddress",
          streetAddress: "{{contact.street}}",
          addressLocality: "Душанбе",
          addressCountry: "TJ",
        },
      },
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

  // Прелоад герой-фото на главной — это LCP-элемент, браузер должен начать
  // качать его до разбора CSS, а не после первого рендера <img>.
  // imagesrcset/imagesizes — чтобы прелоад совпал с тем, что выберет <img>
  // (иначе браузер скачает и прелоад, и другой кандидат). Все герой-страницы
  // (главная, курсы, FAQ…) начинаются с секции hero — прелоадим на каждой.
  const heroType = page.sections[0]?.type;
  const heroEntry = ["hero", "heroBold"].includes(heroType) && !page.sections[0]?.compact ? heroMedia(ctx.media, page) : null;
  const preloadSizes = heroType === "heroBold" ? "100vw" : HERO_SIZES;
  // Preload the same format and candidates as <picture>, avoiding a second
  // WebP download when the browser selects the AVIF source.
  const preloadSrc = heroEntry?.avif || heroEntry?.src;
  const preloadSm = heroEntry?.avif ? heroEntry.avifSm : heroEntry?.srcSm;
  const heroPreload = heroEntry
    ? `<link rel="preload" as="image" href="${esc(preloadSrc)}"${heroEntry.avif ? ' type="image/avif"' : ""}${
        preloadSm
          ? ` imagesrcset="${esc(preloadSm)} ${Math.round((heroEntry.width || 800) / 2)}w, ${esc(preloadSrc)} ${heroEntry.width || 800}w" imagesizes="${preloadSizes}"`
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
    ${page.noindex ? "" : `${alts}\n    <link rel="alternate" hreflang="x-default" href="${esc(pageUrl(site, page.slug, "tg"))}" />`}
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
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:alt" content="${esc(L(page.h1, lang))}" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <meta name="twitter:image:alt" content="${esc(L(page.h1, lang))}" />
    <link rel="icon" href="/favicon.ico?v=20261109-logo" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/favicon.svg?v=20261109-logo" type="image/svg+xml" sizes="any" />
    <link rel="icon" href="/icons/favicon-32.png?v=20261109-logo" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png?v=20261109-logo" />
    <!-- Inter не блокирует отрисовку: подключаем как print, после загрузки
         переключаем на all. Системный шрифт виден сразу (display=swap). -->
    <script>try{if(localStorage.getItem('ssb_theme')==='dark')document.documentElement.dataset.theme='dark'}catch{}</script>
    ${heroPreload}
    <script type="application/ld+json">${ld}</script>`;
}

function pageContents(page, lang) {
  const entries = page.sections.filter((s) => s.id && L(s.h2, lang));
  if (entries.length < 2) return "";
  return `<nav class="page-contents wrap" aria-label="${lang === "tg" ? "Дар ин саҳифа" : "На этой странице"}">${entries.map((s) => `<a href="#${esc(s.id)}">${esc(L(s.h2, lang))}</a>`).join("")}</nav>`;
}

export function renderPage(site, page, lang, now = new Date(), media = null, offlineProgramme = null) {
  const ui = site.ui[lang];
  const ctx = { site, page, ui, now, media, offlineProgramme, wa: waLink(site, L(page.waText, lang) || ui.ctaBuyPrefill) };
  let pageSections = page.sections;
  // На «Арт-десертах» программа курса уже сеткой из 10 фото уроков — отдельный блок образцов дублировал бы её.
  if (page.slug === "online-kurs" && media?.lessonSamples?.length) {
    const at = Math.max(1, pageSections.findIndex((section) => section.type === "menu") + 1);
    pageSections = [...pageSections.slice(0, at), {type: "lessonSamples", id: "iz-urokov"}, ...pageSections.slice(at)];
  }
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

  return applyOfferFacts(`<!doctype html>
<html lang="${lang}">
  <head>
    ${renderHead(site, page, lang, ctx)}
  </head>
  <body>
    ${renderHeader(site, page, lang, ctx)}
    <main id="main">
      ${crumbs}${h1}
      ${page.slug ? pageContents(page, lang) : ""}
      ${sections.join("\n")}
    </main>
    ${renderFooter(site, lang, ctx)}
    ${renderStickyCta(site, ui, ctx)}
    <script type="module" src="/src/site/main.tsx"></script>
  </body>
</html>
`, site, lang);
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
        text: { ru: `${site.ui.ru.notFoundText}`, tg: site.ui.tg.notFoundText },
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
  return renderPage(site, page, "tg", now);
}

function renderSitemap(site, pages) {
  // Build time is not evidence of a substantive content change.
  const urls = pages.filter((p) => !p.noindex).flatMap((p) =>
    LANGS.map((lang) => {
      const alts = [...LANGS.map((l) => [l, pageUrl(site, p.slug, l)]), ["x-default", pageUrl(site, p.slug, "tg")]]
        .map(([l, href]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(href)}" />`)
        .join("\n");
      return `  <url>\n    <loc>${esc(pageUrl(site, p.slug, lang))}</loc>\n${alts}\n  </url>`;
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
# Private application HTML uses noindex; allow crawling to read that rule.
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
  const offlineProgramme = pages.find((page) => page.slug === "kursy-konditera-dushanbe")?.sections.find((section) => section.id === "programma");
  for (const page of pages) {
    for (const lang of LANGS) files.set(outFile(page.slug, lang), renderPage(site, page, lang, now, media, offlineProgramme));
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
