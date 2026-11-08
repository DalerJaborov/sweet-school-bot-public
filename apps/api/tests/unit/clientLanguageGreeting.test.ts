import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  history: [] as string[],
  preferred: null as string | null,
  fail: false,
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    message: {
      findMany: vi.fn(async (args: { where: { payload?: unknown } }) => {
        if (db.fail) throw new Error("db down");
        // Нажатия кнопок (payload) в стиль/язык не идут — проверяем, что их и не просят.
        expect(args.where.payload).toBeNull();
        return db.history.map((text) => ({ text }));
      }),
    },
    contact: { findUnique: vi.fn(async () => ({ preferredLanguage: db.preferred })) },
  },
  logError: vi.fn(),
}));

import { detectClientLanguage, languageSignal, conversationLanguage } from "../../src/ai/clientLanguage.js";
import { contactLanguage } from "../../src/ai/contactLanguage.js";

/** Владелец 08.11.2026: «Салом» пишут и русскоязычные, одно приветствие язык не определяет. */
describe("язык сообщения: приветствие не переключает язык, но и не стирает таджикский", () => {
  it.each([
    ["Салом, сколько стоит онлайн", "ru"],
    ["Ассалом, подскажите цену", "ru"],
    ["Рахмат, понятно", "ru"],
    ["Салом хуб хастед", "tg"],
    ["Ассалому алейкум хуб мегардед", "tg"],
    ["Рахмат калон", "tg"],
    ["Хуб", "tg"],
    ["Майли", "tg"],
    ["Хоп", "tg"],
    ["Ташаккури зиёд", "tg"],
    ["Салом апачон курс чанд пул", "tg"],
    ["Чекро фиристодам апачон", "tg"],
    ["Номатона нависен", "tg"],
    ["Курси «Арт-десерты» чанд", "tg"],
    ["Есть курс где манго используют?", "ru"],
    ["Утро доброе, скоро оплачу", "ru"],
  ])("«%s» — %s", (text, lang) => expect(languageSignal(text)).toBe(lang));

  it("одно приветствие, «спасибо» или общее слово — языка не видно", () => {
    for (const t of ["", "Салом", "Ассалому алейкум!", "Рахмат", "Бале", "Салом апа", "Ок", "Онлайн"]) {
      expect(languageSignal(t)).toBeNull();
    }
    expect(detectClientLanguage("")).toBe("ru");
  });

  it("история: решает первое сообщение, где язык виден", () => {
    expect(conversationLanguage(["Салом", "Курс чанд пул?"])).toBe("tg");
    expect(conversationLanguage(["Рахмат", "Сколько стоит курс?"])).toBe("ru");
    expect(conversationLanguage(["Салом"])).toBeNull();
  });
});

describe("contactLanguage — единая цепочка: сообщение → история → язык с сайта → русский", () => {
  beforeEach(() => {
    db.history = [];
    db.preferred = null;
    db.fail = false;
  });

  it("явный сигнал в сообщении важнее истории", async () => {
    db.history = ["Курс чанд пул?"];
    expect(await contactLanguage("c1", "Салом, сколько стоит онлайн")).toBe("ru");
  });
  it("только фото (текста нет), история на таджикском — таджикский", async () => {
    db.history = ["Салом", "Нархаш чанд?"];
    expect(await contactLanguage("c1", "")).toBe("tg");
  });
  it("«Салом» без истории — русский (ОЦЕНКА: решения владельца нет)", async () => {
    db.history = ["Салом"];
    expect(await contactLanguage("c1", "Салом")).toBe("ru");
  });
  it("истории нет — язык, выбранный на сайте", async () => {
    db.preferred = "tg";
    expect(await contactLanguage("c1", "")).toBe("tg");
  });
  it("сбой базы — не падаем, русский", async () => {
    db.fail = true;
    expect(await contactLanguage("c1", "")).toBe("ru");
  });
});
