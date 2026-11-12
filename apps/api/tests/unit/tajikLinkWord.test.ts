import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanAutomatedReply, cleanKeepingWarmTail, REPLY_POLICY_INSTRUCTION, replaceLinkWord } from "../../src/ai/replyPolicy.js";

// КЛАСС: слово «линк» по-таджикски клиенты не понимают (владелец 12.11.2026).
// Всё, что бот шлёт сам (ответы модели, воронка, шаблоны), проходит cleanKeepingWarmTail в send.ts.
describe("«линк» → «ссылка» в автоматических сообщениях", () => {
  it("меняет слово с таджикскими окончаниями", () => {
    expect(replaceLinkWord("Линки шахсии шумо")).toBe("Ссылкаи шахсии шумо");
    expect(replaceLinkWord("аз линк гирифта будед, линкро кушоен")).toBe("аз ссылка гирифта будед, ссылкаро кушоен");
    expect(replaceLinkWord("линкҳо ва линкхо")).toBe("ссылкаҳо ва ссылкахо");
  });

  it("не трогает другие слова и латиницу в адресах", () => {
    expect(replaceLinkWord("Линкольн https://t.me/link")).toBe("Линкольн https://t.me/link");
  });

  it("работает в общей чистке, через которую идут воронка и ответы модели", () => {
    expect(cleanAutomatedReply("Ин линк факат барои шумо")).toBe("Ин ссылка факат барои шумо");
    expect(cleanKeepingWarmTail("Линкро кушоен 🌸")).toBe("Ссылкаро кушоен 🌸");
  });

  it("модели сказано не писать «линк» и чередовать «ссылка» / «сайти мо»", () => {
    expect(REPLY_POLICY_INSTRUCTION).toMatch(/линк/u);
    expect(REPLY_POLICY_INSTRUCTION).toMatch(/сайти мо/u);
  });

  it("в коде нет готовых текстов клиенту со словом «линк»", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/telegramMenu.ts"), "utf8");
    expect(src).not.toMatch(/Линки шахсии/u);
  });
});
