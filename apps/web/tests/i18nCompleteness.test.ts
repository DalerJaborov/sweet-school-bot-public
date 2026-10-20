import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DICTIONARIES } from "../src/course/i18n";
import { DICTIONARIES as SITE_DICTIONARIES } from "../src/site/i18n";

/**
 * ДВА ЯЗЫКА ВЕЗДЕ. Разбор UX 03.09.2026: таджикоязычная ученица упиралась в
 * русский текст ровно там, где ей нужна помощь — в ошибках, плеере, чате.
 * Этот тест не даёт такому вернуться: каждый ключ есть в обоих словарях, а в
 * компонентах нет кириллицы вне словаря.
 */
describe("Словари RU/TG", () => {
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

  /**
   * ПРАВИЛО ВЛАДЕЛЬЦА: это авторский курс Ширин, а не «школа». Ревью 05.09.2026
   * нашло слово ровно на экране отказа — там, где человек читает без контекста.
   * Проверяем каждое значение обоих словарей (приложение и сайт), функции — по
   * их исходному тексту.
   */
  it("ни в одном значении словарей приложения и сайта нет «школ»/«мактаб»", () => {
    const offenders: string[] = [];
    const scan = (name: string, dict: Record<string, unknown>, prefix = "") => {
      for (const [key, value] of Object.entries(dict)) {
        const path = `${name}.${prefix}${key}`;
        const text =
          typeof value === "function" ? value.toString() : typeof value === "string" ? value : null;
        if (text != null) {
          if (/школ|мактаб/i.test(text)) offenders.push(path);
        } else if (value && typeof value === "object") {
          scan(name, value as Record<string, unknown>, `${prefix}${key}.`);
        }
      }
    };
    scan("course.ru", DICTIONARIES.ru as unknown as Record<string, unknown>);
    scan("course.tg", DICTIONARIES.tg as unknown as Record<string, unknown>);
    scan("site.ru", SITE_DICTIONARIES.ru as unknown as Record<string, unknown>);
    scan("site.tg", SITE_DICTIONARIES.tg as unknown as Record<string, unknown>);
    expect(offenders).toEqual([]);
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

/** Комментарии и JSX-комментарии вырезаем: они по-русски намеренно. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("Кириллица вне словаря", () => {
  it("в компонентах приложения ученицы нет русских строк — всё через t.*", () => {
    const root = path.join(__dirname, "..", "src", "course");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      // Словарь — единственное место для текста. Первый экран знакомства
      // двуязычен по замыслу: язык ещё не выбран.
      if (rel === "i18n.ts" || rel === "Onboarding.tsx") continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        if (/[А-Яа-яЁёӢӣӮӯҲҳҚқҶҷҒғ]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
