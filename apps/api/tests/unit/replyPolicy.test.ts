import { describe, expect, it } from "vitest";
import { cleanAutomatedReply, replyPolicyIssues, CONTEXT_ONLY_AMOUNT, COURSE_DATE_FACT } from "../../src/ai/replyPolicy.js";
import { guardReply } from "../../src/ai/offTopicGuard.js";

const FACTS = "Курс 70 сомони, комплект 100 сомони. 905 355 355. Офлайн 700 сомони";
describe("generated sales reply policy", () => {
  it.each(["Ты можете открыть урок", "Я отправлю тебе", "Ту метавонед нависед", "Туро интизорам"])("holds informal address: %s", (reply) => {
    expect(replyPolicyIssues(reply, FACTS)).toContain("informal_address");
  });
  it("does not rewrite proper words, recipe numbers or respectful forms", () => {
    expect(replyPolicyIssues("Вы готовите торт: 250 г муки. Шумо метавонед нависед", FACTS)).toEqual([]);
  });
  it.each(["Курс стоит 50 сомони", "Курс 80 TJS", "Напишите 999 111 222"])("holds unsupported money or phone: %s", (reply) => {
    expect(replyPolicyIssues(reply, FACTS).length).toBeGreaterThan(0);
  });
  it("permits only factual amounts and phone", () => {
    expect(replyPolicyIssues("70 сомони. Номер +992 905-355-355", FACTS)).toEqual([]);
  });
  it("does not swap the two valid course prices", () => {
    expect(replyPolicyIssues("Арт-десерты стоят 70 сомони", "Арт-десерты — 50 сомони; 21 рецепт — 70 сомони")).toContain("wrong_course_price");
    expect(replyPolicyIssues("21 сомони", "21 рецепт — 70 сомони")).toContain("unverified_amount");
    expect(replyPolicyIssues("Курс 70 USD", FACTS)).toContain("unverified_amount");
  });
  it("cleans complete emoji sequences without touching links or Tajik letters", () => {
    expect(cleanAutomatedReply("Шумо 👩‍🍳: https://example.com/42 🙏🏽" )).toBe("Шумо : https://example.com/42");
  });
  it("directs a paid web student to the actual lesson chat", () => {
    expect(guardReply("recipe_question", "ru", true, "web")).toContain("личном кабинете");
    expect(guardReply("recipe_question", "ru", true, "web")).not.toContain("телеграм");
    expect(guardReply("recipe_question", "ru", false, "web")).not.toContain("кабинете");
  });
});

describe("сумма двух курсов и дата набора — только по фактам «Цены и даты» (08.11.2026)", () => {
  const facts =
    "Арт-десерты — 50 сомони, 21 рецепт — 70 сомони, оба курса вместе — 100 сомони. " +
    `${CONTEXT_ONLY_AMOUNT} 120 сомони. 905 355 355. Офлайн: 700 сомони. ${COURSE_DATE_FACT} 20 ноября.`;

  it("«100 вместо 120» и «по отдельности 120» — можно; «за оба 120» — нет", () => {
    expect(replyPolicyIssues("Оба курса вместе — 100 сомони вместо 120 сомони.", facts)).toEqual([]);
    expect(replyPolicyIssues("Если покупать по отдельности — 120 сомони, а оба курса вместе — 100 сомони.", facts)).toEqual([]);
    expect(replyPolicyIssues("Ҳар ду курс якҷоя 100 сомонӣ, ба ҷои 120 сомонӣ.", facts)).toEqual([]);
    expect(replyPolicyIssues("За оба курса — 120 сомони.", facts)).toContain("unverified_amount");
  });

  it("дата набора в ответе про курс должна совпадать с настроенной (RU и TG)", () => {
    expect(replyPolicyIssues("Офлайн-курс начнётся 20 ноября.", facts)).toEqual([]);
    expect(replyPolicyIssues("Курси офлайн 20 ноябр оғоз мешавад.", facts)).toEqual([]);
    expect(replyPolicyIssues("Офлайн-курс начнётся 3 октября.", facts)).toContain("wrong_course_date");
    expect(replyPolicyIssues("Курси офлайн 25-ум ноябр сар мешавад.", facts)).toContain("wrong_course_date");
    // Не про курс — не трогаем: «чек от 5 ноября».
    expect(replyPolicyIssues("Ваш чек от 5 ноября получили.", facts)).toEqual([]);
  });

  it("дата «уточняется» — любая дата набора задерживается", () => {
    const tbd = facts.replace("20 ноября", "дата следующего набора уточняется");
    expect(replyPolicyIssues("Набор стартует 1 декабря.", tbd)).toContain("wrong_course_date");
    expect(replyPolicyIssues("Дата набора уточняется, напишите — сообщим.", tbd)).toEqual([]);
  });

  it("без метки даты в фактах (старые вызовы) даты не проверяются", () => {
    expect(replyPolicyIssues("Офлайн-курс начнётся 3 октября.", "70 сомони")).toEqual([]);
  });
});