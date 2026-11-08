import { describe, it, expect } from "vitest";
import { SCENARIOS, type Expect } from "../fixtures/relevanceScenarios.js";
import {
  codeRelevance,
  classifyRelevance,
  decideAction,
  parseRelevance,
  clarifyText,
  type RelevanceClass,
} from "../../src/ai/relevance.js";

const actionOf = (cls: RelevanceClass): Expect => {
  const a = decideAction({ cls, source: "code", reason: "" }, { clarifiedBefore: 0 });
  return a === "reply" ? "answer" : a === "silent" ? "silent" : "clarify";
};

describe("relevance: правила кода на сценариях", () => {
  const decided = SCENARIOS.filter((s) => codeRelevance(s.text));
  it("правила решают заметную часть без модели", () => {
    expect(decided.length).toBeGreaterThan(SCENARIOS.length * 0.6);
  });
  for (const sc of SCENARIOS) {
    const v = codeRelevance(sc.text);
    if (!v) continue;
    it(`${sc.id}: «${sc.text.slice(0, 40)}» -> ${sc.expect}`, () => {
      expect(actionOf(v.cls)).toBe(sc.expect);
    });
  }
  it("курьер, но со словами про чек — это наше дело", () => {
    expect(codeRelevance("Курьер, где мой чек за курс?")?.cls).toBe("on_topic");
  });
  it("вложение без подписи правилами не решается", () => {
    expect(codeRelevance("", true)).toBeNull();
    expect(codeRelevance("", false)?.cls).toBe("empty");
  });
});

describe("relevance: разбор ответа модели", () => {
  it("принимает JSON и JSON в обёртке", () => {
    expect(parseRelevance('{"cls":"shop","reason":"поставщик"}')?.cls).toBe("shop");
    expect(parseRelevance('```json\n{"cls":"personal","reason":"x"}\n```')?.cls).toBe("personal");
  });
  it("мусор и неизвестный класс — null", () => {
    expect(parseRelevance("on_topic")).toBeNull();
    expect(parseRelevance('{"cls":"banana"}')).toBeNull();
    expect(parseRelevance(null)).toBeNull();
  });
});

describe("relevance: политика", () => {
  it("unclear: первый раз спрашиваем, второй — к человеку", () => {
    const v = { cls: "unclear" as const, source: "model" as const, reason: "" };
    expect(decideAction(v, { clarifiedBefore: 0 })).toBe("clarify");
    expect(decideAction(v, { clarifiedBefore: 1 })).toBe("attention");
  });
  it("чужие классы молчим", () => {
    for (const cls of ["personal", "delivery", "shop", "spam", "empty"] as const) {
      expect(decideAction({ cls, source: "code", reason: "" }, { clarifiedBefore: 0 })).toBe("silent");
    }
  });
  it("модель упала — fallback, а не тихое «по делу»", async () => {
    const v = await classifyRelevance("Подскажите про торт на юбилей мамы", [], { generate: async () => null });
    expect(v.source).toBe("fallback");
    expect(v.cls).toBe("unclear");
  });
  it("модель сказала «по делу» про явного курьера — второй замок не верит", async () => {
    const v = await classifyRelevance("Я у подъезда, выходите, привёз пакет", [], {
      generate: async () => '{"cls":"on_topic","reason":"ошибка"}',
    });
    expect(v.cls).not.toBe("on_topic");
  });
  it("уточняющий вопрос на трёх языках и таджикский — шаблон Ширин", () => {
    expect(clarifyText("ru")).toMatch(/Здравствуйте/);
    expect(clarifyText("tg")).toContain("Ба шумо кадом маълумоти курсро равон кунем?");
    expect(clarifyText("en")).toMatch(/Hello/);
  });
});
