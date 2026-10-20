import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const generateWithFallback = vi.fn();
vi.mock("../../src/gemini.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gemini.js")>();
  return { ...actual, generateWithFallback: (...a: unknown[]) => generateWithFallback(...a) };
});

import { ocrRecipeCard, parseRecipeCard, recipeCardToMarkdown, mergeRecipeCards } from "../../src/course/cardOcr.js";

/** То, что модель возвращает по схеме, — карточка «Творожный пирог» на таджикском. */
const CARD = {
  title: "Творожный пирог",
  language: "tg",
  components: [
    {
      name: "Хамир",
      items: [
        { ingredient: "Орд", amount: "250", unit: "г", note: null, emoji: "🌾" },
        { ingredient: "Равған", amount: "120", unit: "г", note: "сард", emoji: null },
      ],
    },
    { name: "Крем", items: [{ ingredient: "Творог", amount: "500", unit: "г" }] },
  ],
};

let db: PrismaMock;

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async (args: unknown) => {
    const key = (args as { where: { key: string } }).where.key;
    return key === "geminiKey" ? { key, value: "ключ" } : null;
  });
  generateWithFallback.mockReset();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("parseRecipeCard — разбор ответа модели", () => {
  it("строгий JSON по схеме", () => {
    const card = parseRecipeCard(JSON.stringify(CARD));
    expect(card?.title).toBe("Творожный пирог");
    expect(card?.language).toBe("tg");
    expect(card?.components).toHaveLength(2);
    expect(card?.components[0].items[0].emoji).toBe("🌾");
    expect(card?.components[0].items[1]).toEqual({
      ingredient: "Равған",
      amount: "120",
      unit: "г",
      note: "сард",
      emoji: null,
    });
    expect(card?.components[1].items[0].note).toBeNull();
    expect(card?.components[1].items[0].emoji).toBeNull();
  });

  it("терпит обёртку ```json и числа вместо строк", () => {
    const text = "```json\n" + JSON.stringify({ ...CARD, components: [{ name: "", items: [{ ingredient: "Орд", amount: 250 }] }] }) + "\n```";
    const card = parseRecipeCard(text);
    expect(card?.components[0].items[0].amount).toBe("250");
  });

  it("без единого ингредиента — не карточка", () => {
    expect(parseRecipeCard(JSON.stringify({ title: "X", language: "tg", components: [{ name: "Крем", items: [] }] }))).toBeNull();
    expect(parseRecipeCard("не json")).toBeNull();
    expect(parseRecipeCard("[]")).toBeNull();
  });
});

describe("parseRecipeCard — защита от утечки рассуждений модели в поля (06.09.2026)", () => {
  it("длинное поле unit с посторонним английским текстом — обрезается, не ломает карточку целиком", () => {
    const card = parseRecipeCard(
      JSON.stringify({
        title: "Эклеры",
        language: "tg",
        components: [
          {
            name: "Хамир",
            items: [
              {
                ingredient: "Орд",
                amount: "140",
                unit: "г Serge\n\nWait, no control tokens like \n in JSON! All in single line.",
                note: null,
                emoji: null,
              },
            ],
          },
        ],
      })
    );
    expect(card?.components[0].items[0].ingredient).toBe("Орд");
    expect(card?.components[0].items[0].amount).toBe("140");
    expect(card?.components[0].items[0].unit).toBeNull();
  });

  it("известные бренды на латинице (Ken, Sorbon, Callebaut) не считаются мусором", () => {
    const card = parseRecipeCard(
      JSON.stringify({
        title: "Торт",
        language: "tg",
        components: [{ name: "Крем", items: [{ ingredient: "Сливкии бозори", amount: "300", unit: "г", note: "Ken ё Sorbon", emoji: null }] }],
      })
    );
    expect(card?.components[0].items[0].note).toBe("Ken ё Sorbon");
  });

  it("одинаковые строки в одном компоненте (две карточки одной и той же фотографии) — дедуп, не учетверение", () => {
    const dupItem = { ingredient: "Шакар", amount: "200", unit: "г", note: null, emoji: null };
    const card = parseRecipeCard(
      JSON.stringify({
        title: "Вупи пай",
        language: "tg",
        components: [{ name: "БАРОИ ХАМИР:", items: [dupItem, dupItem, dupItem] }],
      })
    );
    expect(card?.components[0].items).toHaveLength(1);
  });
});

describe("recipeCardToMarkdown", () => {
  it("компоненты жирным, ингредиенты списком, уточнение в скобках", () => {
    const md = recipeCardToMarkdown(parseRecipeCard(JSON.stringify(CARD))!);
    expect(md).toBe("**Хамир**\n- Орд — 250 г\n- Равған — 120 г (сард)\n\n**Крем**\n- Творог — 500 г");
  });
});

describe("mergeRecipeCards — несколько карточек одного урока в recipeData", () => {
  it("компоненты по порядку карточек, название и язык — от первой непустой", () => {
    const first = parseRecipeCard(JSON.stringify({ title: "", language: "", components: [{ name: "Хамир", items: [{ ingredient: "Орд" }] }] }))!;
    const second = parseRecipeCard(JSON.stringify(CARD))!;
    const merged = mergeRecipeCards([first, second]);
    expect(merged?.title).toBe("Творожный пирог");
    expect(merged?.language).toBe("tg");
    expect(merged?.components.map((c) => c.name)).toEqual(["Хамир", "Хамир", "Крем"]);
  });

  it("без единого компонента — null", () => {
    expect(mergeRecipeCards([])).toBeNull();
  });
});

describe("ocrRecipeCard — вызов Gemini", () => {
  const image = Buffer.from("jpeg-bytes");

  it("картинка уходит inline с инструкцией, ответ разбирается", async () => {
    generateWithFallback.mockResolvedValue({ text: JSON.stringify(CARD), model: "gemini-3.6-flash" });
    const card = await ocrRecipeCard(image, "image/jpeg");
    expect(card?.title).toBe("Творожный пирог");
    const [keys, , build] = generateWithFallback.mock.calls[0] as [string[], string, (m: string) => string];
    expect(keys).toEqual(["ключ"]);
    const body = JSON.parse(build("gemini-3.6-flash"));
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: "image/jpeg", data: image.toString("base64") });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual(["title", "components", "language"]);
    const itemProps = body.generationConfig.responseSchema.properties.components.items.properties.items.items.properties;
    expect(Object.keys(itemProps)).toContain("emoji");
  });

  it("нет ключа — не зовём и возвращаем null", async () => {
    db.model("setting").findUnique.mockResolvedValue(null);
    expect(await ocrRecipeCard(image, "image/jpeg")).toBeNull();
    expect(generateWithFallback).not.toHaveBeenCalled();
  });

  it("ошибка модели или мусор в ответе — null, без исключения", async () => {
    generateWithFallback.mockResolvedValueOnce({ error: "квота" });
    expect(await ocrRecipeCard(image, "image/jpeg")).toBeNull();
    generateWithFallback.mockResolvedValueOnce({ text: "Вот рецепт: мука", model: "m" });
    expect(await ocrRecipeCard(image, "image/jpeg")).toBeNull();
    generateWithFallback.mockRejectedValueOnce(new Error("сеть"));
    expect(await ocrRecipeCard(image, "image/jpeg")).toBeNull();
  });
});
