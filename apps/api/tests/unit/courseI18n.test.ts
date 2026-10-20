import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const generateWithFallback = vi.fn();
vi.mock("../../src/gemini.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gemini.js")>();
  return { ...actual, generateWithFallback: (...a: unknown[]) => generateWithFallback(...a) };
});

import { translateMany, isCourseLanguage } from "../../src/course/i18n.js";

let db: PrismaMock;

/** Ответ Gemini в том виде, в каком его отдаёт generateWithFallback. */
function said(values: string[]) {
  return { text: JSON.stringify(values), model: "gemini-3.6-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockResolvedValue({ key: "geminiKey", value: "ключ" });
  db.model("translation").findMany.mockResolvedValue([]);
  db.model("translation").create.mockResolvedValue({});
  generateWithFallback.mockReset();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Перевод содержимого курса", () => {
  it("русский не переводится вовсе — Gemini не зовём", async () => {
    const out = await translateMany(["Медовик", "Наполеон"], "ru");
    expect(out).toEqual(["Медовик", "Наполеон"]);
    expect(generateWithFallback).not.toHaveBeenCalled();
  });

  it("переводит и кладёт в кеш, чтобы не платить за то же второй раз", async () => {
    generateWithFallback.mockResolvedValue(said(["Асал", "Наполеон"]));
    const out = await translateMany(["Медовик", "Наполеон"], "tg");

    expect(out).toEqual(["Асал", "Наполеон"]);
    expect(db.model("translation").create).toHaveBeenCalledTimes(2);
  });

  it("что уже в кеше — не идёт в Gemini повторно", async () => {
    db.model("translation").findMany.mockResolvedValue([
      // Хеш вычисляет сам модуль; берём его из первого прогона ниже.
      { hash: sha("Медовик"), lang: "tg", text: "Асал" },
    ]);
    generateWithFallback.mockResolvedValue(said(["Наполеон"]));

    const out = await translateMany(["Медовик", "Наполеон"], "tg");

    expect(out).toEqual(["Асал", "Наполеон"]);
    // В модель ушла ОДНА строка, а не обе.
    const body = JSON.parse((generateWithFallback.mock.calls[0][2] as (m: string) => string)("m"));
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual(["Наполеон"]);
  });

  it("ГЛАВНОЕ: Gemini молчит — отдаём русский текст, а не пустой экран", async () => {
    generateWithFallback.mockResolvedValue({ error: "вышло отведённое время" });
    const out = await translateMany(["Медовик"], "tg");
    expect(out).toEqual(["Медовик"]);
  });

  it("ответ не той длины отбрасываем целиком: перевод не к той строке хуже, чем его отсутствие", async () => {
    generateWithFallback.mockResolvedValue(said(["Асал"]));
    const out = await translateMany(["Медовик", "Наполеон"], "tg");
    expect(out).toEqual(["Медовик", "Наполеон"]);
    expect(db.model("translation").create).not.toHaveBeenCalled();
  });

  it("повторяющийся текст переводится один раз и подставляется во все места", async () => {
    generateWithFallback.mockResolvedValue(said(["Асал"]));
    const out = await translateMany(["Медовик", "Медовик", ""], "tg");
    expect(out).toEqual(["Асал", "Асал", ""]);
    expect(db.model("translation").create).toHaveBeenCalledTimes(1);
  });

  it("язык проверяется, а не принимается на веру из базы", () => {
    expect(isCourseLanguage("tg")).toBe(true);
    expect(isCourseLanguage("ru")).toBe(true);
    expect(isCourseLanguage("en")).toBe(false);
    expect(isCourseLanguage(null)).toBe(false);
  });
});

function sha(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto").createHash("sha256").update(text).digest("hex");
}
