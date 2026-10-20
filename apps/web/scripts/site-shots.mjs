/**
 * СКРИНШОТЫ ПУБЛИЧНОГО САЙТА shirinsweets.online — все статичные страницы из
 * site-content/pages в headless Chrome: телефон 375×812 @2x и ПК 1280×800.
 * Нужны для ревью картинок/вёрстки «до/после» без ручного клика по страницам.
 *
 * Только локально: сначала `npm run build`, затем сервер `vite preview`
 * (порт 4173, см. .claude/launch.json → site-preview) или `npm run dev`.
 *
 *   node scripts/site-shots.mjs [--out <dir>] [--full] [--base http://localhost:4173]
 *
 * По умолчанию base = http://localhost:4173 (vite preview раздаёт dist/, где
 * главная лежит как /site.html — путь страницы берём из build-site-pages).
 * --full — не только первый экран, а «лента» экранов по высоте окна (до 6).
 *
 * puppeteer-core без своего Chrome: берём установленный (CHROME_PATH или
 * стандартный путь Windows). Нет Chrome — скрипт честно выходит.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadContent } from "./build-site-pages.mjs";

const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const outDir = path.resolve(arg("--out", "site-screens"));
const fullPage = args.includes("--full");
const base = arg("--base", process.env.SHOT_BASE ?? "http://localhost:4173");
const chrome = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(chrome)) {
  console.error(`Chrome не найден: ${chrome} — пропускаю`);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORTS = {
  mobile: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Страницы: главная — /site.html в dist (vite preview), остальные — /<slug>.html. */
const { pages } = loadContent();
const targets = pages.map((p) => ({
  name: p.slug || "home",
  url: `${base}/${p.slug ? `${p.slug}.html` : "site.html"}`,
}));

async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  ${name}.png`);
  if (!fullPage) return;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = page.viewport().height;
  for (let i = 1; i * vh < total && i < 6; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * vh);
    await sleep(350);
    await page.screenshot({ path: path.join(outDir, `${name}-${i + 1}.png`) });
  }
}

async function run(mode) {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[mode]);
  page.on("pageerror", (e) => console.warn("  page error:", e.message));
  console.log(`\n== ${mode} ==`);
  for (const t of targets) {
    await page
      .goto(t.url, { waitUntil: "networkidle0", timeout: 30000 })
      .catch((e) => console.warn(`  ! ${t.url}: ${e.message}`));
    // Раскрыть <details> (аккордеон десертов), чтобы вся сетка попала в ленту.
    if (fullPage) await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    // Ленивые картинки: прокрутить до конца и обратно, чтобы они загрузились.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await sleep(800);
    await shot(page, `${t.name}-${mode}`);
  }
  await browser.close();
}

for (const mode of ["mobile", "desktop"]) await run(mode);
console.log(`\nГотово: ${outDir}`);
