import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";
import { allocate, COURSE_50, COURSE_70, COURSE_TITLE, BUNDLE_PRICE, BUNDLE_FULL_PRICE } from "../../src/courses.js";
import { ALWAYS_RULES, DEFAULT_PROMPT } from "../../src/ai/prompts.js";
import { buildInstruction } from "../../src/ai/receiptCheck.js";

/**
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 05.09.2026: комплект «оба курса» стоит 100 сомони, и это
 * ПУБЛИЧНАЯ цена. Раньше сайт говорил «100 вместо 120», бот — «за оба 120»,
 * а код считал 100 договорной скидкой и слал владельцу тревогу. Теперь все
 * четыре голоса читают prices.ts.
 */
describe("Цена комплекта — одна на сайт, бота, чек и allocate()", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("purchase").findMany.mockResolvedValue([]);
  });
  afterEach(restorePrisma);

  it("100 сомони → оба курса, без пометки «договорная»", async () => {
    const plan = await allocate("c1", BUNDLE_PRICE);
    expect(plan.grant).toEqual([COURSE_50, COURSE_70]);
    expect(plan).not.toHaveProperty("discounted");
    expect(plan.note).not.toMatch(/договорн/);
  });

  it("120 сомони (по сумме двух курсов) → тоже просто оба курса", async () => {
    const plan = await allocate("c1", BUNDLE_FULL_PRICE);
    expect(plan.grant).toEqual([COURSE_50, COURSE_70]);
    expect(plan.note).not.toMatch(/договорн/);
  });

  it("комиссия банка: 95 сомони — всё ещё комплект, а не один курс за 70", async () => {
    expect((await allocate("c1", 95)).grant).toEqual([COURSE_50, COURSE_70]);
  });

  it("одиночные цены не сломались: 50 и 70 → свой курс, 30 → никому", async () => {
    expect((await allocate("c1", 50)).grant).toEqual([COURSE_50]);
    expect((await allocate("c1", 70)).grant).toEqual([COURSE_70]);
    expect((await allocate("c1", 30)).grant).toEqual([]);
  });

  it("уже куплен один курс — 100 сомони не открывает «оба», берётся ближайший одиночный", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ course: COURSE_50 }]);
    const plan = await allocate("c1", 70);
    expect(plan.grant).toEqual([COURSE_70]);
  });

  it("названия курсов — без цены в скобках", () => {
    for (const title of Object.values(COURSE_TITLE)) expect(title).not.toMatch(/сомони|\(/);
  });

  it("промт и правила называют 100 за оба и не называют 120 как цену", () => {
    expect(DEFAULT_PROMPT).toContain("оба курса вместе — 100 сомони");
    expect(ALWAYS_RULES).toContain("оба курса вместе — 100 сомони");
    expect(ALWAYS_RULES).not.toMatch(/120/);
    expect(DEFAULT_PROMPT).not.toMatch(/120/);
  });

  it("сертификат — за просмотр всех уроков, без фото (решение 05.09.2026)", () => {
    expect(ALWAYS_RULES).toContain("когда все уроки просмотрены");
    expect(ALWAYS_RULES).toMatch(/Никаких фото десертов/);
  });

  it("реквизиты одной строкой с получателем; «настоящее имя» — только если спросят (владелец 05.09)", () => {
    expect(ALWAYS_RULES).toContain("«905 355 355 Чаборова Фарангис (Душанбе Сити, Алиф)»");
    expect(ALWAYS_RULES).toContain("Ничего про имя не объясняй сам");
    expect(ALWAYS_RULES).toContain("Фарангис Чаборова — это настоящее имя Ширин");
    expect(ALWAYS_RULES).toContain("Фарангис Ҷабборова — номи аслии Ширин аст");
    // «сестра» встречается только внутри запрета — не как объяснение.
    expect(ALWAYS_RULES).toMatch(/Никогда не говори «сестра»/);
  });

  it("инструкция проверки чека ждёт те же суммы, что allocate()", () => {
    const text = buildInstruction();
    expect(text).toContain("50 сомони");
    expect(text).toContain("70 сомони");
    expect(text).toContain(`${BUNDLE_PRICE} сомони`);
    expect(text).toContain(`${BUNDLE_FULL_PRICE} сомони`);
    expect(text).not.toMatch(/школ/i);
  });
});

describe("правило 22: возврат денег и платёжные реквизиты клиента", () => {
  it("бот не оформляет возврат сам и не собирает номер карты клиента", () => {
    expect(ALWAYS_RULES).toContain("Передаю Ширин, она сама с вами решит");
    expect(ALWAYS_RULES).toMatch(/НЕ ПРЕДЛАГАЕШЬ, НЕ ОБЕЩАЕШЬ и НЕ ОФОРМЛЯЕШЬ/);
    expect(ALWAYS_RULES).toMatch(/НИКОГДА не спрашивай и не принимай номер банковской карты/);
  });
});
