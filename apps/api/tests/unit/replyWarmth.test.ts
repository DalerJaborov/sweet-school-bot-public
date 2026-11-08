import { describe, it, expect, afterEach } from "vitest";
import { mockPrisma, restorePrisma } from "../helpers.js";
import { isPureThanks, pickReaction, REACTIONS } from "../../src/ai/reactions.js";
import { maybeWarmEmoji } from "../../src/voice.js";
import { withoutBotAuthored, languageBonus } from "../../src/ai/styleLearning.js";

afterEach(restorePrisma);

describe("реакция вместо ответа: только чистая благодарность", () => {
  it.each(["Спасибо", "Спасибо большое!", "рахмат апачон", "Раҳмат", "Ташаккур ❤️", "thanks"])("«%s» — благодарность", (t) => {
    expect(isPureThanks(t)).toBe(true);
  });
  it.each(["Спасибо, а когда начало?", "Рахмат, нархи курс чанд?", "Сколько стоит", "", "Спасибо за информацию, оплачу завтра"])(
    "«%s» — не только благодарность",
    (t) => {
      expect(isPureThanks(t)).toBe(false);
    }
  );
  it("реакция всегда из тёплого списка и стабильна для одного сообщения", () => {
    const a = pickReaction("mid-1");
    expect(REACTIONS).toContain(a);
    expect(pickReaction("mid-1")).toBe(a);
  });
});

describe("редкое тёплое смайлик-окончание", () => {
  it("не трогает цифры, ссылки, вопросы и уже имеющиеся смайлики", () => {
    for (const t of ["Оплата 70 сомони", "Вот ссылка https://x.tj", "Вам удобно?", "Хорошо 🌸"]) {
      for (let i = 0; i < 40; i++) expect(maybeWarmEmoji(t + " ".repeat(i))).toBe(t + " ".repeat(i));
    }
  });
  it("ставит смайлик примерно в каждом восьмом коротком тёплом ответе", () => {
    let withEmoji = 0;
    for (let i = 0; i < 400; i++) if (maybeWarmEmoji(`Хорошо апачон, ждём ${"а".repeat(i % 50)}`) !== `Хорошо апачон, ждём ${"а".repeat(i % 50)}`) withEmoji++;
    expect(withEmoji).toBeGreaterThan(20);
    expect(withEmoji).toBeLessThan(110);
  });
});

describe("образцы стиля: бот не учится на самом себе", () => {
  it("отсеивает тексты, уже отправленные ботом, и служебный мусор", async () => {
    const db = mockPrisma();
    db.model("message").findMany.mockResolvedValue([{ text: "Шаблон бота" }]);
    const pool = [{ ownerText: "Шаблон бота" }, { ownerText: "Бале дорем хохарчон" }, { ownerText: "Automation powered by @Manychat" }, { ownerText: "Drafting the Response:**" }];
    const out = await withoutBotAuthored(pool);
    expect(out.map((e) => e.ownerText)).toEqual(["Бале дорем хохарчон"]);
  });
  it("даёт бонус образцу на языке клиента", () => {
    expect(languageBonus({ ownerText: "Бале дорем, ҳамаи рецептҳо ҳаст" }, "tg")).toBeGreaterThan(0);
    expect(languageBonus({ ownerText: "Здравствуйте, курс стоит семьдесят" }, "tg")).toBe(0);
    expect(languageBonus({ ownerText: "Здравствуйте, курс стоит семьдесят" }, "en")).toBe(0);
  });
});
