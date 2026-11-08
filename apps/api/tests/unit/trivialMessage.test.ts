import { describe, it, expect } from "vitest";
import { isTrivialKind, isTrivialMessage } from "../../src/trivialMessage.js";

describe("isTrivialMessage — пустяки не показываем", () => {
  it.each([
    "Рахмат", "рахмат!", "Хоб майла", "Воалейкум асалом", "Ассалому алайкум", "салом", "Ок", "ok", "Хорошо, спасибо", "Большое спасибо вам",
    "Спасибо 🙏", "🙏", "👍👍", "", "   ", null, undefined, "Ташаккур калон", "Добрый день", "Да", "Хуб",
  ])("пустяк: %j", (t) => {
    expect(isTrivialMessage(t as string)).toBe(true);
  });

  it.each([
    "Позовите Ширин", "Рахмат, а сколько стоит курс?", "Ок, когда начало?", "Салом, нарх чанд?", "Не работает ссылка", "Хочу вернуть деньги", "Привет, как оплатить",
  ])("настоящий вопрос: %s", (t) => {
    expect(isTrivialMessage(t)).toBe(false);
  });

  it("реакции и стикеры — пустяк по виду события", () => {
    expect(isTrivialKind("reaction")).toBe(true);
    expect(isTrivialKind("sticker")).toBe(true);
    expect(isTrivialKind("text")).toBe(false);
    expect(isTrivialKind(null)).toBe(false);
  });
});
