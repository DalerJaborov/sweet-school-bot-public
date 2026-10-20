/**
 * СКРИНШОТЫ ПАНЕЛИ ДЛЯ ВЛАДЕЛИЦЫ — обход всех экранов «Утро Ширин» в
 * headless Chrome и PNG на диск: телефон 375×812 @2x и ПК 1280×800.
 *
 * Только локально, dev-серверы должны быть подняты (api :4100, web :5181,
 * см. .claude/launch.json) и база засеяна `npx tsx scripts/seed-demo.ts`.
 *
 *   SHOT_TOKEN=<jwt> node scripts/shots.mjs [--out <dir>] [--full]
 *
 * SHOT_TOKEN — токен из POST /admin/login (в скрипте пароль не нужен: токен
 * кладётся в localStorage до загрузки страницы, форма входа не открывается).
 * --full — вся страница целиком, а не только первый экран (для ревью).
 *
 * puppeteer-core без своего Chrome: берём установленный (CHROME_PATH или
 * стандартный путь Windows). Нет Chrome — скрипт честно выходит.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.resolve("screens");
const fullPage = args.includes("--full");
const token = process.env.SHOT_TOKEN;
const base = process.env.SHOT_BASE ?? "http://localhost:5181";
const chrome = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!token) {
  console.error("SHOT_TOKEN не задан");
  process.exit(1);
}
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

/** Клик по кнопке/ссылке с точным (после trim) текстом внутри selector. */
async function clickText(page, selector, text) {
  const ok = await page.evaluate(
    ({ selector, text }) => {
      const els = [...document.querySelectorAll(selector)];
      const el = els.find((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim().includes(text));
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    { selector, text }
  );
  if (!ok) console.warn(`  ! не нашёл «${text}» в ${selector}`);
  await sleep(900);
  return ok;
}

/** Открыть раздел: на телефоне через нижнюю навигацию/«Ещё», на ПК — сайдбар. */
async function goTab(page, mode, label) {
  if (mode === "desktop") return clickText(page, ".sidebar-nav button", label);
  const primary = ["Сегодня", "Задачи", "Ученицы"];
  if (primary.includes(label)) return clickText(page, ".nav button", label);
  await clickText(page, ".nav button", "Ещё");
  return clickText(page, ".sheet-item", label);
}

/** Один экран — PNG; с --full ещё и «ленту» из экранов по высоте окна (до 5),
 *  чтобы длинную страницу можно было прочитать по кускам, а не одной простынёй. */
async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${path.basename(file)}`);
  if (!fullPage) return;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = page.viewport().height;
  for (let i = 1; i * vh < total && i < 5; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * vh);
    await sleep(350);
    await page.screenshot({ path: path.join(outDir, `${name}-${i + 1}.png`) });
  }
}

async function run(mode) {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox", "--font-render-hinting=none"] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[mode]);
  await page.evaluateOnNewDocument((t) => localStorage.setItem("ssb_token", t), token);
  page.on("pageerror", (e) => console.warn("  page error:", e.message));
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".bento", { timeout: 15000 });
  await sleep(1200); // шрифты и count-up

  const m = mode;
  console.log(`\n== ${m} ==`);
  await shot(page, `01-today-${m}`);

  await goTab(page, m, "Задачи");
  await page.waitForSelector(".tasks-seg").catch(() => {});
  await sleep(600);
  await shot(page, `02-receipts-${m}`);
  await clickText(page, ".tasks-seg button", "Вопросы");
  await sleep(600);
  await shot(page, `03-questions-${m}`);

  await goTab(page, m, "Ученицы");
  await sleep(800);
  await shot(page, `04-students-${m}`);
  // Карточка первой ученицы — ник в списке.
  const opened = await page.evaluate(() => {
    const b = document.querySelector(".list-title button.linklike, .person-name button, button[aria-label^='Открыть карточку']");
    if (!b) return false;
    b.click();
    return true;
  });
  if (opened) {
    await sleep(900);
    await shot(page, `05-student-${m}`);
  }

  await goTab(page, m, "Деньги");
  await sleep(900);
  await shot(page, `06-money-${m}`);

  await goTab(page, m, "Курсы");
  await sleep(900);
  await shot(page, `07-courses-${m}`);
  if (await clickText(page, "button", "Проверить рецепты")) {
    await sleep(700);
    await shot(page, `08-recipes-list-${m}`);
    const card = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".list-row button, .list-row a")].find((e) => /Проверить|Открыть/.test(e.textContent ?? ""));
      if (!b) return false;
      b.click();
      return true;
    });
    if (card) {
      await sleep(900);
      await shot(page, `09-recipe-review-${m}`);
    }
  }

  await goTab(page, m, "Импорт");
  await sleep(700);
  await shot(page, `10-import-${m}`);

  await goTab(page, m, "Тексты и цены");
  await sleep(900);
  await shot(page, `11-texts-${m}`);

  await goTab(page, m, "Настройки");
  await sleep(900);
  await shot(page, `12-settings-${m}`);

  // Поиск: ⌘K на ПК, кнопка-лупа на телефоне.
  await goTab(page, m, "Сегодня");
  await sleep(500);
  if (m === "desktop") {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
  } else {
    await page.evaluate(() => document.querySelector(".topbar-actions button")?.click());
  }
  await sleep(500);
  await page.keyboard.type("мадина", { delay: 40 });
  await sleep(1000);
  await shot(page, `13-search-${m}`);
  await page.keyboard.press("Escape");

  if (m === "mobile") {
    await clickText(page, ".nav button", "Ещё");
    await sleep(400);
    await shot(page, `14-more-${m}`);
    await page.keyboard.press("Escape");
  }

  await browser.close();
}

for (const mode of ["mobile", "desktop"]) {
  await run(mode);
}
console.log(`\nГотово: ${outDir}`);
