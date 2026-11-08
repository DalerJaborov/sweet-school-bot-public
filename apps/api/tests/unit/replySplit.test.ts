import { describe, it, expect } from "vitest";
import { splitHumanLike, splitOptionsFor } from "../../src/ai/replySplit.js";

const ON = { enabled: true, maxParts: 4 };

describe("ответ несколькими короткими сообщениями", () => {
  it("короткий ответ остаётся одним сообщением", () => {
    expect(splitHumanLike("Хорошо, ждём вас", ON)).toEqual(["Хорошо, ждём вас"]);
  });
  it("длинный текст режется по предложениям, слова не рвутся", () => {
    const text =
      "У нас два онлайн курса. Первый — 21 рецепт, там базовые десерты и кремы. Второй — арт-десерты, девять современных десертов. " +
      "Оба курса идут в записи, смотреть можно в любое время. Сертификат выдаётся в конце обучения.";
    const parts = splitHumanLike(text, ON);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(4);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    for (const p of parts) expect(p).toMatch(/[.!?…]$/);
  });
  it("номер оплаты и ссылка уходят отдельным сообщением", () => {
    const parts = splitHumanLike("Оплатите курс на номер ниже и пришлите чек.\n905355355 Алиф\nПосле проверки вышлем ссылку на уроки.", ON);
    expect(parts).toContain("905355355 Алиф");
    expect(parts.filter((p) => p.includes("905355355"))).toHaveLength(1);
    const link = splitHumanLike("Вот ссылка:\nhttps://shirinsweets.online/c/abc", ON);
    expect(link).toContain("https://shirinsweets.online/c/abc");
  });
  it("потолок частей: лишнее склеивается, реквизиты остаются отдельно", () => {
    const text = "Раз. Это первая мысль которая достаточно длинная чтобы стать отдельной частью ответа клиентке. " +
      "Это вторая мысль, тоже довольно длинная и подробная, чтобы не склеиваться с первой сама по себе. " +
      "Это третья мысль, и она тоже не короткая, поэтому ещё один отдельный кусок. 905355355";
    const parts = splitHumanLike(text, { enabled: true, maxParts: 2 });
    expect(parts.length).toBeLessThanOrEqual(2);
    expect(parts.join(" ")).toContain("905355355");
  });
  it("рубильник выключен: только явные «---», с потолком", () => {
    const long = "а".repeat(50) + ". " + "б".repeat(150) + ".";
    expect(splitHumanLike(long, { enabled: false, maxParts: 3 })).toEqual([long]);
    expect(splitHumanLike("Раз\n---\nДва\n---\nТри\n---\nЧетыре", { enabled: false, maxParts: 3 })).toEqual(["Раз", "Два", "Три Четыре"]);
  });
  it("настройки: WhatsApp не больше двух частей, рубильник по каналам", () => {
    expect(splitOptionsFor("WHATSAPP", { maxParts: "6" })).toEqual({ enabled: true, maxParts: 2 });
    expect(splitOptionsFor("INSTAGRAM", {})).toEqual({ enabled: true, maxParts: 4 });
    expect(splitOptionsFor("WEB", { web: "false" }).enabled).toBe(false);
    expect(splitOptionsFor("INSTAGRAM", { web: "false" }).enabled).toBe(true);
  });
});
