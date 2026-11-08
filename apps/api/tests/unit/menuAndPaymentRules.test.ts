import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: { message: { findMany: vi.fn(async () => []) } },
  recordOutgoingMessage: vi.fn(),
  getSetting: vi.fn(async () => null),
  logError: vi.fn(),
}));
vi.mock("../../src/env.js", () => ({ env: { publicBaseUrl: "https://shirinsweets.online" } }));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(), sendImageToContact: vi.fn() }));

import { detectMenuQuestion } from "../../src/ai/offTopicGuard.js";
import { inferCourses, menuImageUrl } from "../../src/ai/menuImages.js";
import { buildAlwaysRules } from "../../src/ai/prompts.js";
import { buildFreeLessonBlock, freeLessonUrl } from "../../src/ai/freeLessonHook.js";

describe("просьба показать меню", () => {
  it.each([
    "меню",
    "Покажите меню курса",
    "рӯйхати шириниҳоро фиристед",
    "чӣ меомӯзонед дар курс?",
    "чему я научусь на курсе",
    "какие десерты в курсе",
  ])("узнаёт «%s»", (text) => {
    expect(detectMenuQuestion(text)).toBe(true);
  });

  it.each(["сколько стоит курс", "Ассалому алайкум апачон", "чекро фиристодам", "менюшка не нужна мне вообще"])(
    "не принимает за просьбу меню «%s»",
    (text) => {
      expect(detectMenuQuestion(text)).toBe(false);
    },
  );
});

describe("какое меню слать", () => {
  it("называет курс сам — история не мешает", () => {
    expect(inferCourses("покажите меню офлайн курса", ["у вас 70 сомон курс"])).toEqual(["offline"]);
    expect(inferCourses("меню арт-десерт", [])).toEqual(["online50"]);
    expect(inferCourses("меню курса 21 рецепт", [])).toEqual(["online70"]);
  });
  it("по истории: один курс — его одного", () => {
    expect(inferCourses("покажите меню", ["Дар курси 70 сомона инхо"])).toEqual(["online70"]);
  });
  it("не понял — оба онлайн-меню, офлайн без упоминания не шлём", () => {
    expect(inferCourses("покажите меню", [])).toEqual(["online70", "online50"]);
  });
  it("ссылки на картинки лежат на сайте и различаются по языку", () => {
    expect(menuImageUrl("offline", "tg")).toBe("https://shirinsweets.online/img/menus/menu-offline-tg.jpg");
    expect(menuImageUrl("online70", "ru")).toBe("https://shirinsweets.online/img/menus/menu-online-70-ru.jpg");
  });
});

describe("правила бота про оплату, имя и чек", () => {
  const rules = buildAlwaysRules();
  it("реквизиты не навязываются и не повторяются", () => {
    expect(rules).toContain("НЕ ДАВИ И НЕ ТОРОПИ С ОПЛАТОЙ");
    expect(rules).toContain("не повторяй");
  });
  it("на «как вас зовут» — Ширин, без имени с карты", () => {
    expect(rules).toContain("Меня зовут Ширин");
    expect(rules).toContain("Номи ман Ширин");
  });
  it("экран проверки получателя — не чек и не подделка; нет чека — просто попросить", () => {
    expect(rules).toContain("ЭКРАН ПРОВЕРКИ ПОЛУЧАТЕЛЯ");
    expect(rules).toContain("Чекро фиристед");
  });
  it("названия десертов не переводятся", () => {
    expect(rules).toContain("НАЗВАНИЯ ДЕСЕРТОВ НЕ ПЕРЕВОДИ");
  });
  it("бесплатный урок — только когда включён блок", () => {
    expect(rules).toContain("БЕСПЛАТНЫЙ УРОК");
  });
});

describe("крючок — бесплатный урок", () => {
  it("блок содержит ссылку и запрет совмещать с просьбой об оплате", () => {
    const block = buildFreeLessonBlock(freeLessonUrl());
    expect(block).toContain("https://shirinsweets.online/online-kurs#free-lesson-island");
    expect(block).toContain("никогда не стоят в одном сообщении");
  });
});
