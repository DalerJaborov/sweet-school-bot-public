import { describe, it, expect } from "vitest";
// @ts-expect-error — скрипт на чистом ESM без типов.
import { buildCards } from "../../scripts/render-menu-cards.mjs";

type Card = { file: string; ru: { rows: string[] }; tg: { rows: string[] } };
const cards: Card[] = buildCards();

describe("картинки-меню для чата", () => {
  it("три меню: онлайн 70, онлайн 50, офлайн", () => {
    expect(cards.map((c) => c.file)).toEqual(["menu-online-70", "menu-online-50", "menu-offline"]);
  });

  it("названия десертов на таджикском остаются русскими (правило владельца)", () => {
    for (const card of cards.filter((c) => c.file !== "menu-offline")) {
      expect(card.tg.rows).toEqual(card.ru.rows);
    }
  });

  it("21 десерт в меню онлайн-курса и ни одной пустой строки", () => {
    expect(cards[0].ru.rows).toHaveLength(21);
    for (const card of cards) {
      for (const lang of ["ru", "tg"] as const) {
        expect(card[lang].rows.length).toBeGreaterThan(3);
        expect(card[lang].rows.every((r) => typeof r === "string" && r.length > 2 && r !== "undefined")).toBe(true);
      }
    }
  });

  it("цен и дат на картинках нет — они меняются в «Текстах и ценах»", () => {
    for (const card of cards) {
      for (const lang of ["ru", "tg"] as const) {
        expect(card[lang].rows.join(" ")).not.toMatch(/сомон|сом\b|TJS/iu);
      }
    }
  });
});
