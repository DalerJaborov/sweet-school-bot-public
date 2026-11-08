// Яркие баннеры для WhatsApp и Instagram: «21 рецепт», «Арт-десерты», офлайн-курс в Душанбе, RU и TG.
//
// Всё, что написано на баннере, берётся из site-content (те же файлы, что собирают сайт), а фото —
// настоящие, из public/img/desserts. Ни выдуманных отзывов, цифр и обещаний, ни цен и дат: цены
// живут в разделе «Цены и даты», картинка устарела бы молча. Названия десертов на таджикском не
// переводим (правило владельца 08.11.2026) — здесь их вообще нет, только фото.
//
// Запуск: node apps/web/scripts/render-promo-banners.mjs   (нужен Chrome; путь — CHROME_PATH)
// Выход: apps/web/public/img/banners/banner-<курс>-<ru|tg>.jpg, 1080×1350 (4:5 — влезает и в ленту
// Instagram, и в чат WhatsApp без обрезки).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, "..", "site-content");
const imgDir = path.join(here, "..", "public", "img");
const outDir = path.join(imgDir, "banners");
const read = (f) => JSON.parse(fs.readFileSync(path.join(content, f), "utf8"));
const section = (page, type) => page.sections.find((s) => s.type === type);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Три баннера × два языка. photos — файлы из public/img/desserts, chips — короткие факты с сайта. */
export function buildBanners() {
  const online = read("pages/online-kurs.json");
  const art = read("pages/art-desserty.json");
  const offline = read("pages/kursy-konditera-dushanbe.json");
  const ticker = (page, idx) => {
    const t = section(page, "heroBold").ticker;
    return { ru: idx.map((i) => t.ru[i]), tg: idx.map((i) => t.tg[i]) };
  };
  // Факты офлайн-курса без подстановок ({{offline.price}} и т.п.) — цен и дат на баннере нет.
  const offlineChips = (lang) =>
    section(offline, "offline")
      .facts.map((f) => f.text[lang])
      .filter((t) => !t.includes("{{"))
      .slice(0, 3);

  const t70 = ticker(online, [1, 2, 3]);
  const t50 = ticker(art, [1, 2, 3, 4]);
  return [
    {
      file: "banner-online-70",
      photos: ["klubnika-v-shokolade", "krasnyj-barhat", "snikers", "rafaello"],
      ru: { eyebrow: "ОНЛАЙН-КУРС", title: "21 РЕЦЕПТ", lead: "Видеоуроки на таджикском языке — смотрите с телефона", chips: t70.ru },
      tg: { eyebrow: "КУРСИ ОНЛАЙН", title: "21 РЕЦЕПТ", lead: "Видеодарсҳо бо забони тоҷикӣ — аз телефон тамошо кунед", chips: t70.tg },
    },
    {
      file: "banner-online-50",
      photos: ["art-desert-cover", "fistashkovoe-pirozhnoe", "chizkejk-dubajskij-shokolad", "shu"],
      ru: { eyebrow: "ОНЛАЙН-КУРС", title: "АРТ-ДЕСЕРТЫ", lead: "10 видеоуроков на таджикском языке", chips: t50.ru },
      tg: { eyebrow: "КУРСИ ОНЛАЙН", title: "АРТ-ДЕСЕРТЫ", lead: "10 видеодарс бо забони тоҷикӣ", chips: t50.tg },
    },
    {
      file: "banner-offline",
      photos: ["shokoladnyj-tort", "vupi-paj", "chizkejk-tortiki", "shokoladnoe-pirozhnoe-s-ganashom"],
      ru: { eyebrow: "ОФЛАЙН-КУРС", title: "В ДУШАНБЕ", lead: "Всё включено — доплачивать не нужно", chips: offlineChips("ru") },
      tg: { eyebrow: "КУРСИ ОФЛАЙН", title: "ДАР ДУШАНБЕ", lead: "Ҳама чиз дохил — изофа пардохт лозим нест", chips: offlineChips("tg") },
    },
  ];
}

const CTA = { ru: "Напишите нам — расскажем подробнее", tg: "Ба мо нависед — муфассал мегӯем" };

function dataUri(name) {
  const buf = fs.readFileSync(path.join(imgDir, "desserts", `${name}.webp`));
  return `data:image/webp;base64,${buf.toString("base64")}`;
}

function html(b, lang) {
  const c = b[lang];
  const photos = b.photos.map((p) => `<div class="ph" style="background-image:url('${dataUri(p)}')"></div>`).join("");
  const chips = c.chips.map((t) => `<span>${esc(t)}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1350px;background:#7a1f1f;font-family:'Segoe UI','Trebuchet MS',Arial,sans-serif;overflow:hidden}
.grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:6px;height:660px}
.ph{background-size:cover;background-position:center}
.panel{position:relative;height:690px;padding:56px 64px 48px;background:linear-gradient(160deg,#c2185b 0%,#8e1b4a 55%,#6a1b3a 100%);color:#fff;text-align:center}
.brand{position:absolute;top:-34px;left:50%;transform:translateX(-50%);background:#ffd54f;color:#6a1b3a;font-weight:800;letter-spacing:.28em;font-size:26px;padding:14px 34px;border-radius:40px;white-space:nowrap}
.eyebrow{margin-top:14px;font-size:34px;letter-spacing:.3em;color:#ffd54f;font-weight:700}
h1{margin-top:8px;font-size:${c.title.length > 10 ? 104 : 140}px;line-height:1;font-weight:900;letter-spacing:.02em;text-shadow:0 4px 0 rgba(0,0,0,.25)}
.lead{margin-top:20px;font-size:38px;line-height:1.25;color:#ffeef4}
.chips{margin-top:30px;display:flex;flex-wrap:wrap;gap:14px;justify-content:center}
.chips span{background:rgba(255,255,255,.16);border:2px solid rgba(255,255,255,.55);border-radius:40px;padding:10px 26px;font-size:30px;font-weight:600}
.cta{position:absolute;left:64px;right:64px;bottom:46px;background:#ffd54f;color:#6a1b3a;border-radius:60px;padding:20px 24px;font-size:36px;font-weight:800}
</style></head><body>
<div class="grid">${photos}</div>
<div class="panel"><div class="brand">SHIRIN SWEETS</div>
<div class="eyebrow">${esc(c.eyebrow)}</div><h1>${esc(c.title)}</h1>
<div class="lead">${esc(c.lead)}</div><div class="chips">${chips}</div>
<div class="cta">${esc(CTA[lang])}</div></div>
</body></html>`;
}

async function main() {
  const { default: puppeteer } = await import("puppeteer-core");
  const chrome =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error("Chrome не найден: задайте CHROME_PATH");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    for (const b of buildBanners()) {
      for (const lang of ["ru", "tg"]) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
        await page.setContent(html(b, lang), { waitUntil: "load" });
        const file = path.join(outDir, `${b.file}-${lang}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 88 });
        await page.close();
        console.log("готово:", file);
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
