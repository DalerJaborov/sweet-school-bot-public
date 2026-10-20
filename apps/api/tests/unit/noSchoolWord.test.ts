import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT, ALWAYS_RULES, BUDGET_FALLBACK } from "../../src/ai/prompts.js";
import { guardReply, type GuardKind } from "../../src/ai/offTopicGuard.js";
import { receiptNotSeenReply } from "../../src/ai/receiptClaim.js";
import type { ClientLanguage } from "../../src/ai/clientLanguage.js";

/**
 * ПРАВИЛО ВЛАДЕЛЬЦА: это авторский курс Ширин, а не «школа». Ревью 05.09.2026
 * нашло слово в промте по умолчанию, в правилах модели и в шаблоне «не по
 * теме» — то есть ровно там, где его читает клиентка или повторяет модель.
 */
const FORBIDDEN = /школ|мактаб|school/i;
const LANGS: ClientLanguage[] = ["ru", "tg", "en"];
const SPEAKING: Exclude<GuardKind, "freeloader">[] = [
  "probing",
  "asks_bot",
  "offtopic",
  "task_request",
  "recipe_question",
  "no_such_course",
  "order_request",
  "wants_human",
];

describe("Слова «школа» нет в текстах для клиентки", () => {
  it("промт по умолчанию и незыблемые правила", () => {
    expect(DEFAULT_PROMPT).not.toMatch(FORBIDDEN);
    expect(ALWAYS_RULES).not.toMatch(FORBIDDEN);
    expect(ALWAYS_RULES).toContain("Ширин");
  });

  it("язык уроков в правилах — честная формула, а не «только на таджикском»", () => {
    expect(ALWAYS_RULES).toContain("Ширин в видео говорит по-таджикски");
    expect(ALWAYS_RULES).toContain("на русском и таджикском");
    expect(ALWAYS_RULES).not.toMatch(/уроки курса и телеграм-канал только на таджикском/);
  });

  it("заглушка исчерпанного бюджета — на всех языках", () => {
    for (const lang of LANGS) expect(BUDGET_FALLBACK[lang]).not.toMatch(FORBIDDEN);
  });

  it("шаблоны отсечки по теме — все виды, все языки, для гостя и ученицы", () => {
    for (const kind of SPEAKING) {
      for (const lang of LANGS) {
        expect(guardReply(kind, lang, false), `${kind}/${lang}`).not.toMatch(FORBIDDEN);
        expect(guardReply(kind, lang, true), `${kind}/${lang}/student`).not.toMatch(FORBIDDEN);
      }
    }
    expect(guardReply("offtopic", "ru")).toContain("Ширин");
  });

  it("детерминированный ответ «чек не вижу»", () => {
    for (const lang of LANGS) {
      expect(receiptNotSeenReply(lang, true)).not.toMatch(FORBIDDEN);
      expect(receiptNotSeenReply(lang, false)).not.toMatch(FORBIDDEN);
    }
  });
});
