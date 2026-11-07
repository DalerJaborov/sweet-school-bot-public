import { describe, expect, it } from "vitest";
import { cleanAutomatedReply, replyPolicyIssues } from "../../src/ai/replyPolicy.js";
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
