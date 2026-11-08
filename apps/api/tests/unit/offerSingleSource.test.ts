import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFER_SETTING_KEYS } from "../../src/services/settingsService.js";
import { DEFAULT_OFFLINE_ADDRESS_TG, DEFAULT_OFFLINE_FACTS, parseHours } from "../../src/ai/offlineFacts.js";
import { reminderText } from "../../src/offlineReminder.js";

/**
 * СТОРОЖ «ОДНА ДВЕРЬ ДЛЯ ЦЕН И ДАТ» (08.11.2026).
 *
 * Класс ошибки, который он ловит: цена, дата набора, часы или число десертов,
 * вписанные в код, промт, подпись или текст сайта мимо раздела «Цены и даты».
 * Так уже было: «50/70 сомона» в подписи меню, «50 и 70, оба — 100» в ночном
 * разборе, «13:40» и другой адрес в напоминании, «14:00 до 17:00, Рудаки» в
 * карточке бота, «700 сомони / 13:40–16:30 / 20 десертов» в текстах сайта.
 * Падает с именем файла и строкой — исправлять подстановкой из источника:
 *   API: getPrices() / getOfflineFacts() / courseDateLabel();
 *   сайт: {{offline.price}}, {{offline.hours}}, {{offline.timeFrom}}, … (SSI).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "tests"].includes(entry.name)) out.push(...walk(full, exts));
    } else if (exts.test(entry.name)) out.push(full);
  }
  return out;
}

/** Код без комментариев — история в комментариях («раньше было 50 сомони») не нарушение. */
function codeLines(file: string): { n: number; text: string }[] {
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  return src.split("\n").map((line, i) => ({ n: i + 1, text: line.replace(/(^|[^:"'`])\/\/.*$/, "$1") }));
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

function offenders(files: string[], pattern: RegExp, allow: string[] = []): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (allow.includes(rel(file))) continue;
    for (const { n, text } of codeLines(file))
      if (pattern.test(text)) hits.push(`${rel(file)}:${n}: ${text.trim().slice(0, 120)}`);
  }
  return hits;
}

const apiSrc = walk(path.join(ROOT, "apps/api/src"), /\.ts$/);
const webSrc = walk(path.join(ROOT, "apps/web/src"), /\.tsx?$/);
const siteContent = walk(path.join(ROOT, "apps/web/site-content"), /\.json$/);

describe("цены и даты — один источник", () => {
  it("число рядом с «сомони» не вписано в код API и панели (только подстановка ${…})", () => {
    const price = /(?<![\w$.{])\d{2,6}\s*(?:сомон|сомона|с\.)/iu;
    expect(offenders([...apiSrc, ...webSrc], price)).toEqual([]);
  });

  it("название курса с ценой («Арт-десерты · 50», «курс за 70») не вписано", () => {
    const titled = /(Арт-десерт\p{L}*|21 рецепт)\s*[·(—-]\s*\d{2,4}\b|курс\p{L}* за \d{2,4}/iu;
    expect(offenders([...apiSrc, ...webSrc], titled)).toEqual([]);
  });

  it("часы очного курса (13:40, 16:30) — только в offlineFacts.ts", () => {
    const { from, to } = parseHours(DEFAULT_OFFLINE_FACTS.hours)!;
    const hours = new RegExp(`${from}|${to}`);
    expect(offenders([...apiSrc, ...webSrc], hours, ["apps/api/src/ai/offlineFacts.ts"])).toEqual([]);
  });

  it("ключи цен и дат в Settings называет только их дверь и читатели", () => {
    const allowed = [
      "apps/api/src/services/settingsService.ts", // список ключей и запрет общего пути
      "apps/api/src/services/offerService.ts", // единственный писатель
      "apps/api/src/services/priceService.ts", // читатель цен
      "apps/api/src/services/salesTextsService.ts", // читатель фактов офлайна
      "apps/api/src/ai/courseDate.ts", // читатель даты набора
    ];
    const keys = new RegExp(`["'\`](${OFFER_SETTING_KEYS.join("|")})["'\`]`);
    expect(offenders([...apiSrc, ...webSrc], keys, allowed)).toEqual([]);
  });

  it("тексты сайта: цена, часы и число десертов — только подстановкой {{offline.*}}", () => {
    const hits: string[] = [];
    const { from, to } = parseHours(DEFAULT_OFFLINE_FACTS.hours)!;
    // Число десертов ОЧНОГО курса: старое «20» запрещено везде (владелец 08.11.2026: 21);
    // «21 десерт» онлайн-курса — свойство продукта «21 рецепт», не цена и не набор.
    const bad = new RegExp(`\\d{2,6}\\s*сомон|${from}|${to}|(?<!\\d)20\\s*(десерт|видов|намуд|ширинӣ)`, "iu");
    // site.json → offline — запасные значения для SSI; их сверяет следующий тест.
    for (const file of siteContent.filter((f) => !f.endsWith("site.json"))) {
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (bad.test(line)) hits.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
    // И положительно: на страницах очного курса число десертов — подстановкой.
    for (const page of ["home.json", "kursy-konditera-dushanbe.json"]) {
      expect(fs.readFileSync(path.join(ROOT, "apps/web/site-content/pages", page), "utf8")).toContain(
        "{{offline.desserts}}",
      );
    }
  });

  it("запасные значения сайта (site.json → offline) совпадают с умолчаниями бота", () => {
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/web/site-content/site.json"), "utf8")) as {
      offline: { price: number; days: number; hours: string; desserts: number };
    };
    expect(site.offline).toMatchObject({
      price: DEFAULT_OFFLINE_FACTS.price,
      days: DEFAULT_OFFLINE_FACTS.days,
      hours: DEFAULT_OFFLINE_FACTS.hours,
      desserts: DEFAULT_OFFLINE_FACTS.desserts,
    });
  });

  it("адрес очного курса: одно поле панели; запасное значение сайта совпадает с ботом", () => {
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/web/site-content/site.json"), "utf8")) as {
      contacts: { address: { ru: string; tg: string }; street?: string; maps?: string };
    };
    expect(site.contacts.address).toEqual({ ru: DEFAULT_OFFLINE_FACTS.address, tg: DEFAULT_OFFLINE_ADDRESS_TG });
    // Второй копии адреса (street/maps) в site.json больше нет — подвал и JSON-LD берут поле панели.
    expect(site.contacts.street).toBeUndefined();
    expect(site.contacts.maps).toBeUndefined();
    expect(reminderText("ru", "", DEFAULT_OFFLINE_FACTS)).toContain(DEFAULT_OFFLINE_FACTS.address);
    expect(reminderText("tg", "", DEFAULT_OFFLINE_FACTS)).toContain(DEFAULT_OFFLINE_ADDRESS_TG);
    const addressLiteral = /Воданасос|Водонасос|Рудаки\s*1\d\d|Рӯдакӣ\s*1\d\d|Додо|Dodo/iu;
    const pages = walk(path.join(ROOT, "apps/web/site-content/pages"), /\.json$/);
    const buildScripts = [path.join(ROOT, "apps/web/scripts/build-site-pages.mjs")];
    expect(offenders([...apiSrc, ...webSrc, ...pages, ...buildScripts], addressLiteral, ["apps/api/src/ai/offlineFacts.ts"])).toEqual([]);
  });
});