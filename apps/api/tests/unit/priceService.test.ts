import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { getPrices, savePrices, resetPriceCache } from "../../src/services/priceService.js";
import { allocate, COURSE_50, COURSE_70 } from "../../src/courses.js";
import { buildInstruction } from "../../src/ai/receiptCheck.js";
import { getSalesTexts, resetSalesTextsCache } from "../../src/services/salesTextsService.js";
import { buildAlwaysRules } from "../../src/ai/prompts.js";
import { DEFAULT_PRICES } from "../../src/prices.js";

/**
 * РАЗДЕЛ «ТЕКСТЫ И ЦЕНЫ» (05.09.2026): цены живут в Settings, prices.ts —
 * только умолчания. Бот, чек и allocate() обязаны читать одно и то же.
 */
function settings(values: Record<string, string>) {
  return async ({ where }: { where: { key: string } }) =>
    values[where.key] ? { key: where.key, value: values[where.key] } : null;
}

describe("priceService", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetPriceCache();
    resetSalesTextsCache();
    db.model("setting").findUnique.mockResolvedValue(null);
    db.model("purchase").findMany.mockResolvedValue([]);
  });
  afterEach(restorePrisma);

  it("настроек нет — цены из prices.ts (50 / 70 / 100, сумма 120)", async () => {
    expect(await getPrices()).toEqual(DEFAULT_PRICES);
  });

  it("настройки переопределяют цены, сумма двух курсов выводится сама", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ priceCourse50: "60", priceCourse70: "90", priceBundle: "130" }));
    const p = await getPrices();
    expect(p.price[COURSE_50]).toBe(60);
    expect(p.price[COURSE_70]).toBe(90);
    expect(p.bundle).toBe(130);
    expect(p.bundleFull).toBe(150);
  });

  it("мусор или ноль в настройке — значение по умолчанию, а не NaN и не 0", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ priceCourse50: "abc", priceCourse70: "0" }));
    const p = await getPrices();
    expect(p.price[COURSE_50]).toBe(50);
    expect(p.price[COURSE_70]).toBe(70);
  });

  it("allocate() раскладывает по ценам из настроек: 90 → курс, который стоил 70", async () => {
    db.model("setting").findUnique.mockImplementation(settings({ priceCourse50: "60", priceCourse70: "90", priceBundle: "130" }));
    expect((await allocate("c1", 90)).grant).toEqual([COURSE_70]);
    expect((await allocate("c1", 130)).grant).toEqual([COURSE_50, COURSE_70]);
    // 70 больше не цена ни одного курса и не дотягивает до 60+30 — ближайший 60.
    expect((await allocate("c1", 70)).grant).toEqual([COURSE_50]);
  });

  it("savePrices пишет Settings И Course.price по коду курса, кэш сбрасывается", async () => {
    db.model("setting").upsert.mockResolvedValue({});
    db.model("course").updateMany.mockResolvedValue({ count: 1 });
    await getPrices(); // прогреть кэш умолчаниями
    const written: Record<string, string> = {};
    db.model("setting").upsert.mockImplementation(async (args: unknown) => {
      const { where, create } = args as { where: { key: string }; create: { value: string } };
      written[where.key] = create.value;
      return {};
    });
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      written[where.key] ? { value: written[where.key] } : null
    );

    const p = await savePrices({ course50: 55, course70: 75, bundle: 110 });

    expect(written).toEqual({ priceCourse50: "55", priceCourse70: "75", priceBundle: "110" });
    expect(db.model("course").updateMany).toHaveBeenCalledWith({ where: { code: COURSE_50 }, data: { price: 55 } });
    expect(db.model("course").updateMany).toHaveBeenCalledWith({ where: { code: COURSE_70 }, data: { price: 75 } });
    expect(p.price[COURSE_50]).toBe(55);
    expect(p.bundleFull).toBe(130);
  });

  it("правила бота и инструкция чека называют цены из настроек, а не из кода", async () => {
    db.model("setting").findUnique.mockImplementation(
      settings({ priceCourse50: "60", priceCourse70: "90", priceBundle: "130", paymentPhone: "900 000 000", paymentBanks: "Алиф" })
    );
    const texts = await getSalesTexts();
    const rules = buildAlwaysRules(texts);
    expect(rules).toContain("Арт-десерты — 60 сомони, 21 рецепт — 90 сомони, оба курса вместе — 130 сомони");
    expect(rules).toContain("«900 000 000 Чаборова Фарангис (Алиф)»");
    const instruction = buildInstruction(await getPrices(), {
      phone: texts.paymentPhone,
      banks: texts.paymentBanks,
      recipient: texts.paymentRecipient,
    });
    expect(instruction).toContain("60 сомони");
    expect(instruction).toContain("130 сомони");
    expect(instruction).toContain("150 сомони");
    expect(instruction).toContain("+992900000000");
  });
});
