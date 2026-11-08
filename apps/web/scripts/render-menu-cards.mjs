// Картинки-меню для отправки клиентам в чат (бот шлёт их по просьбе «покажите меню»).
//
// Берёт списки десертов и программы из site-content — тех же файлов, из которых
// собран сайт, — поэтому меню и сайт не могут разойтись. Ни цен, ни дат на
// картинках нет нарочно: они меняются в «Текстах и ценах», а картинка устарела
// бы молча. Цену и дату называет бот текстом из проверенных фактов.
//
// Запуск: node apps/web/scripts/render-menu-cards.mjs
// Нужен установленный Chrome/Chromium (путь можно задать CHROME_PATH).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, "..", "site-content");
const outDir = path.join(here, "..", "public", "img", "menus");
const read = (f) => JSON.parse(fs.readFileSync(path.join(content, f), "utf8"));
const section = (page, type) => page.sections.find((s) => s.type === type);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Три карточки × два языка. rows — строки списка, lead — подзаголовок. */
export function buildCards() {
  const site = read("site.json");
  const art = read("pages/art-desserty.json");
  const offline = read("pages/kursy-konditera-dushanbe.json");
  // Названия десертов НИКОГДА не переводим на таджикский (правило владельца
  // 08.11.2026: в Таджикистане их знают по-русски) — в обеих версиях берём ru.
  const dessert = () => site.desserts.map((d) => d.ru);
  const artLessons = () => section(art, "menu").items.map((i) => i.ru);
  const offlineFacts = (lang) => section(offline, "offline").facts.map((f) => f.text[lang]);
  const offlineSteps = (lang) => section(offline, "steps").items.slice(0, 2).map((i) => i.title[lang]);

  return [
    {
      file: "menu-online-70",
      ru: { title1: "МЕНЮ", title2: "ОНЛАЙН-КУРСА", lead: "21 десерт — видеоуроки крупным планом", rows: dessert(), numbered: true },
      tg: { title1: "МЕНЮИ КУРСИ", title2: "ОНЛАЙН", lead: "21 ширинӣ — видеодарсҳо аз наздик", rows: dessert(), numbered: true },
    },
    {
      file: "menu-online-50",
      ru: { title1: "ПРОГРАММА", title2: "АРТ-ДЕСЕРТЫ", lead: "10 видеоуроков онлайн-курса", rows: artLessons(), numbered: true },
      tg: { title1: "БАРНОМАИ КУРС", title2: "АРТ-ДЕСЕРТ", lead: "10 видеодарси курси онлайн", rows: artLessons(), numbered: true },
    },
    {
      file: "menu-offline",
      ru: {
        title1: "ОФЛАЙН-КУРС",
        title2: "В ДУШАНБЕ",
        lead: "Всё включено — доплачивать не нужно",
        rows: [...offlineSteps("ru"), ...offlineFacts("ru")],
        numbered: false,
      },
      tg: {
        title1: "КУРСИ ОФЛАЙН",
        title2: "ДАР ДУШАНБЕ",
        lead: "Ҳама чиз дохил — изофа пардохт лозим нест",
        rows: [...offlineSteps("tg"), ...offlineFacts("tg")],
        numbered: false,
      },
    },
  ];
}

function html(card, lang) {
  const rows = card.rows
    .map((r, i) => `<li><span class="n">${card.numbered ? i + 1 + "." : "•"}</span><span>${esc(r)}</span></li>`)
    .join("");
  const tagline = lang === "ru" ? "Вкус, который вдохновляет" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1080px;background:#fdf1e7;font-family:Georgia,'Times New Roman',serif;color:#5b2323}
.card{position:relative;margin:36px;border:3px solid #e9c9bd;border-radius:6px;padding:70px 70px 60px;background:
 radial-gradient(circle at 0% 0%,#f6cfc8 0,transparent 38%),radial-gradient(circle at 100% 100%,#f6d6cd 0,transparent 40%),#fdf1e7}
.brand{text-align:center;letter-spacing:.38em;font-size:30px;color:#5b2323}
.brand small{display:block;margin-top:6px;font-size:15px;letter-spacing:.3em;color:#8a5a50}
h1{margin-top:44px;text-align:center;font-size:84px;line-height:1.05;font-weight:700;color:#7a1f1f}
h1 span{display:block;font-size:64px}
.lead{margin-top:20px;text-align:center;font-size:30px;color:#8a5a50;font-style:italic}
hr{margin:34px auto;width:70%;border:0;border-top:2px solid #e2bdb1}
ul{list-style:none;padding:0 20px}
li{display:flex;gap:22px;font-size:40px;line-height:1.28;padding:7px 0}
.n{width:64px;text-align:right;flex:none;color:#7a1f1f}
.tag{margin-top:46px;text-align:center;font-size:44px;color:#9c3a3a;font-style:italic}
</style></head><body><div class="card">
<div class="brand">SHIRIN SWEETS<small>${lang === "ru" ? "КОНДИТЕРСКИЕ КУРСЫ" : "КУРСҲОИ ҚАННОДӢ"}</small></div>
<h1>${esc(card.title1)}<span>${esc(card.title2)}</span></h1>
<div class="lead">${esc(card.lead)}</div><hr><ul>${rows}</ul>
${tagline ? `<div class="tag">${esc(tagline)}</div>` : ""}
</div></body></html>`;
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
    for (const card of buildCards()) {
      for (const lang of ["ru", "tg"]) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 1200, deviceScaleFactor: 1 });
        await page.setContent(html(card[lang], lang), { waitUntil: "load" });
        const file = path.join(outDir, `${card.file}-${lang}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 88, fullPage: true });
        await page.close();
        console.log("готово:", file);
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
