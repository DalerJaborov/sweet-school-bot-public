import { describe, it, expect } from "vitest";
import { priceOrChoice, declinesPayment, defersPayment } from "../../src/ai/paymentIntent.js";
import { declinedInOrder } from "../../src/ai/repeatGuard.js";
import { withoutOfferQuestion, priceSentence } from "../../src/ai/requisitesOffer.js";
import { detectInstagramFaq, parseFaqExtras } from "../../src/ai/instagramFaq.js";
import { DEFAULT_PRICES } from "../../src/prices.js";

/** Слова вокруг оплаты (разбор 16.11.2026) — одно место для всех трёх решений. */
describe("цена или выбор курса → цена и номер сразу", () => {
  it.each([
    "чанд сомонӣ?",
    "Чанд пул?",
    "нархаш чанд",
    "Сколько стоит?",
    "сколько?",
    "цена какая",
    "хочу купить",
    "мехарам",
    "харидан мехоҳам",
    "куда переводить?",
    "номер карты дайте",
    "рақами корт",
    "21 рецепт",
    "💚ОНЛАЙН 21 РЕЦЕПТ",
    "арт",
    "арт десерт",
    "ҳарду",
    "оба курса",
    "70 сомони за день?",
  ])("%s", (t) => expect(priceOrChoice(t)).not.toBeNull());

  it.each([
    "А сертификат будет?",
    "21 рецепт чиҳо дорад?",
    "какие десерты в арт?",
    "офлайн курс чанд пул?",
    "🏠ДАР НАЗДИ МАН",
    "я оплатила, вот чек",
    "пардохт кардам",
    "чанд рӯз давом мекунад?",
    "сколько уроков?",
    "Салом",
  ])("не про оплату: %s", (t) => expect(priceOrChoice(t)).toBeNull());

  it("какой курс назван: 21 → 70, арт → 50, оба → комплект", () => {
    expect(priceOrChoice("21 рецепт")).toEqual({ courses: ["COURSE70"], bundle: false });
    expect(priceOrChoice("арт чанд?")).toEqual({ courses: ["COURSE50"], bundle: false });
    expect(priceOrChoice("ҳарду курс чанд")?.bundle).toBe(true);
  });
});

describe("«не надо / позже» и «завтра переведу» — разные вещи", () => {
  it.each(["не надо", "не надо, позже", "пока нет", "баъдтар", "ҳоло не", "лозим нест", "намехоҳам", "потом"])(
    "отказ: %s",
    (t) => expect(declinesPayment(t)).toBe(true),
  );
  it.each(["позже переведу", "пагоҳ мепартоям", "хорошо"])("не отказ: %s", (t) => expect(declinesPayment(t)).toBe(false));

  it.each([
    "пагох",
    "пагоҳ пулро мефиристам",
    "завтра переведу",
    "маслиҳат кунам",
    "с мужем посоветуюсь",
    "картамда пул мемонам",
    "шавҳарам мепартояд",
    "мардакам пул мепартояд",
    "як-ду рӯз пас",
    "подумаю",
  ])("отсрочка: %s", (t) => expect(defersPayment(t)).toBe(true));
  it.each(["не надо, завтра тоже не надо", "я оплатила вчера", "сколько стоит", "Салом"])("не отсрочка: %s", (t) =>
    expect(defersPayment(t)).toBe(false),
  );

  it("последний сигнал решает: «не надо» → молчим; потом «куда переводить?» → снова можно", () => {
    expect(declinedInOrder(["21 рецепт", "не надо, позже"])).toBe(true);
    expect(declinedInOrder(["не надо, позже", "куда переводить?"])).toBe(false);
    expect(declinedInOrder(["не надо", "а сертификат будет?"])).toBe(true);
  });
});

describe("вопрос «отправить реквизиты?» вырезается кодом", () => {
  it.each([
    "Хотите, реквизиты отправлю?",
    "Отправить вам номер карты?",
    "Если хотите, подскажу, как оформить.",
    "Реквизитҳоро фиристам?",
    "Рақами кортро фиристам?",
    "Агар хоҳед, рақами кортро равон мекунам.",
  ])("%s", (q) => {
    const r = withoutOfferQuestion(`Нархаш 70 сомонӣ. ${q}`, "905 355 355");
    expect(r.removed).toBe(true);
    expect(r.text).toBe("Нархаш 70 сомонӣ.");
  });
  it("фразу с самим номером не трогаем", () => {
    expect(withoutOfferQuestion("Номер карты 905 355 355, отправить чек сюда?", "905 355 355").removed).toBe(false);
  });
  it("цена одной фразой по-таджикски", () => {
    expect(priceSentence({ courses: [], bundle: false }, DEFAULT_PRICES, "tg")).toBe(
      "21 рецепт 70 сомонӣ, арт десерт 50 сомонӣ, ҳарду курс якҷоя 100 сомонӣ.",
    );
  });
});

describe("готовые вопросы Meta — список в коде и дополнение настройкой", () => {
  it("пять вопросов рекламы и вопрос профиля узнаются", () => {
    expect(detectInstagramFaq("Как долго доступен курс?")).toBe("duration");
    expect(detectInstagramFaq("Включает ли стоимость kursa сертификат?")).toBe("certificate");
    expect(detectInstagramFaq("Можно ли купить отдельные рецепты?")).toBe("single_recipes");
    expect(detectInstagramFaq("Как долго длится курс?")).toBe("length");
    expect(detectInstagramFaq("Могу ли я с кем-нибудь пообщаться?")).toBe("talk");
    expect(detectInstagramFaq("Как долго идёт офлайн курс?")).toBeNull();
  });
  it("настройка дополняет, а не подменяет; мусорные строки пропускаются", () => {
    const extras = parseFaqExtras("certificate: Сертификат дадите?\nнепонятно\nwrong_kind: что-то");
    expect(detectInstagramFaq("сертификат дадите", extras)).toBe("certificate");
    expect(detectInstagramFaq("Как долго доступен курс?", extras)).toBe("duration");
    expect(extras.size).toBe(1);
  });
});
