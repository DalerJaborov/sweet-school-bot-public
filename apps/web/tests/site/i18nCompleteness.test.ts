import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DICTIONARIES } from "../../src/site/i18n";

/**
 * То же правило, что и для приложения ученицы (tests/i18nCompleteness):
 * каждый ключ есть в обоих словарях сайта, а в компонентах src/site/**
 * нет кириллицы вне словаря — таджикская страница не должна внезапно
 * заговорить по-русски в форме или чате.
 */
describe("Словари сайта RU/TG", () => {
  it("каждый ключ RU есть в TG того же типа, и наоборот", () => {
    const ru = DICTIONARIES.ru as Record<string, unknown>;
    const tg = DICTIONARIES.tg as Record<string, unknown>;
    for (const key of Object.keys(ru)) {
      expect(tg, `нет ключа ${key} в TG`).toHaveProperty(key);
      expect(typeof tg[key], `тип ${key}`).toBe(typeof ru[key]);
      if (typeof ru[key] === "string") {
        expect(String(ru[key]).trim(), `пустой RU ${key}`).not.toBe("");
        expect(String(tg[key]).trim(), `пустой TG ${key}`).not.toBe("");
      }
    }
    for (const key of Object.keys(tg)) expect(ru, `лишний ключ ${key} в TG`).toHaveProperty(key);
  });

  it("в словаре нет слова «школа» — только «курс Ширин»", () => {
    const all = JSON.stringify(DICTIONARIES, (_k, v) => (typeof v === "function" ? v.toString() : v));
    expect(/школ/i.test(all)).toBe(false);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("Кириллица вне словаря сайта", () => {
  it("в src/site/** русские строки только в i18n.ts", () => {
    const root = path.join(__dirname, "..", "..", "src", "site");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      if (rel === "i18n.ts" || rel === "chat/strings.ts") continue;
      const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/[А-Яа-яЁёӢӣӮӯҲҳҚқҶҷҒғ]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
