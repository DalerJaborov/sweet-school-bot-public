import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { funnelMenuFits } from "../../src/ai/firstMessage.js";
import { detectInstagramFaq, instagramFaqAnswer } from "../../src/ai/instagramFaq.js";
import { explicitOfflineInterest } from "../../src/ai/offlineHandoff.js";
import { saysNoTelegram, saysHasTelegram } from "../../src/course/deliveryChoice.js";
import {
  telegramOnlyIssues,
  unverifiedClaimIssues,
  isAskShirin,
  replyPolicyIssues,
  REPLY_POLICY_INSTRUCTION,
} from "../../src/ai/replyPolicy.js";
import { withoutRepeats, asksForReceipt, claimsReceiptAccepted, mentionsPaymentPhone, type RepeatContext } from "../../src/ai/repeatGuard.js";
import { guardOffTopic } from "../../src/ai/offTopicGuard.js";
import { ALWAYS_RULES, DEFAULT_SALES_TEXTS } from "../../src/ai/prompts.js";
import { DEFAULT_PRICES } from "../../src/prices.js";
import { DEFAULT_OFFLINE_FACTS, OFFLINE_DESSERTS_DEFAULT } from "../../src/ai/offlineFacts.js";
import { maybeWarmEmoji } from "../../src/voice.js";
import { parseMenuMedia, DEFAULT_MENU_MEDIA } from "../../src/ai/menuImages.js";
import { asksForProof, hasDoubtSignal } from "../../src/ai/testimonials.js";

/**
 * Разбор 48 часов переписок (11.11.2026, scratchpad/conv/report.md): тесты на КЛАСС
 * каждой ошибки, примеры — живые фразы клиентов (без ников).
 */

describe("п.1 первый вопрос не глотается меню воронки", () => {
  it("настоящие вопросы первым сообщением — не меню, отвечает ИИ", () => {
    for (const q of [
      "Как долго доступен курс?",
      "Ассалом  / Можно узнать какие рецепты входят ?",
      "Кай сар мешавад",
      "Ретсепаша партоид",
      "Включает ли стоимость kursa сертификат?",
      "Нархаш чанд?",
      "онлайн курс хаст?",
      "Урови по рецепту на видео?",
    ]) {
      expect(funnelMenuFits(q), q).toBe(false);
    }
  });
  it("приветствие, «апа», «курс», «маълумот» — меню воронки к месту", () => {
    for (const q of ["Салом", "Салом алейкум", "Асаломуалайкум опчон", "апа", "Курс", "маълумот", "Салом апа курс", "+", "❤️"]) {
      expect(funnelMenuFits(q), q).toBe(true);
    }
  });
  it("фото или голос первым сообщением — не меню (это чек или вопрос)", () => {
    expect(funnelMenuFits(null, true)).toBe(false);
    expect(funnelMenuFits("Салом", true)).toBe(false);
  });
  it("готовые вопросы Instagram распознаются и получают точный ответ из фактов", () => {
    expect(detectInstagramFaq("Как долго доступен курс?")).toBe("duration");
    expect(detectInstagramFaq("Можно ли купить отдельные рецепты?")).toBe("single_recipes");
    expect(detectInstagramFaq("Включает ли стоимость kursa сертификат?")).toBe("certificate");
    expect(detectInstagramFaq("Расскажите подробнее о вашей компании")).toBe("about");
    expect(detectInstagramFaq("Как долго идёт офлайн курс?")).toBeNull();
    const single = instagramFaqAnswer("single_recipes", "ru", DEFAULT_PRICES);
    expect(single).toContain("отдельно не продаются");
    expect(single).toContain("70");
    expect(single).toContain("100");
    for (const kind of ["duration", "single_recipes", "certificate", "about"] as const) {
      for (const lang of ["ru", "tg"] as const) {
        const a = instagramFaqAnswer(kind, lang, DEFAULT_PRICES);
        // Без выдумок: ни «в программе», ни сроков, ни скачивания.
        expect(unverifiedClaimIssues(a), `${kind}/${lang}`).toEqual([]);
        expect(telegramOnlyIssues(a)).toEqual([]);
        expect(a).not.toMatch(/апа|\p{Extended_Pictographic}/u);
      }
    }
  });
});

describe("п.3 офлайн — только по явным словам", () => {
  it("«курс», «кай сар мешавад», «онлаен», «арзон», «ҳарду курс», «нависед» — НЕ офлайн", () => {
    for (const q of ["Курс", "Кай сар мешавад", "Онлаен", "ани арзон", "ҲАР ДУ ҚУРС", "Номерамро нависед", "хочу на курс", "запишите на онлайн курс", "Кай мешава?"]) {
      expect(explicitOfflineInterest(q), q).toBe(false);
    }
  });
  it("офлайн / очно / адрес / 700 / дар назди ман / прийти в Душанбе — офлайн", () => {
    for (const q of ["офлайн курс кай?", "Очно есть?", "адрес куҷо?", "700 сомони чи дохил?", "🏠ДАР НАЗДИ МАН", "Дар Душанбе омада ёд гирам мешавад?", "Сурогатон?"]) {
      expect(explicitOfflineInterest(q), q).toBe(true);
    }
  });
  it("адрес и число десертов — одно место, Рудаки 177 и 22 вида", () => {
    expect(OFFLINE_DESSERTS_DEFAULT).toBe(22);
    expect(DEFAULT_OFFLINE_FACTS.desserts).toBe(22);
    expect(DEFAULT_OFFLINE_FACTS.address).toMatch(/Рудаки 177/);
  });
});

describe("п.4 Telegram или сайт", () => {
  it("«телеграм надорам», «ватсап мешавад?», «нет телеграма» — уроки на сайте", () => {
    for (const q of ["ватсап кати мешава телеграм надорм", "Телеграм надорам", "Вацап да намешад партоен", "у меня нет телеграма", "WhatsApp можно?", "телеграм ичозат нест", "бе телеграм мешавад?"]) {
      expect(saysNoTelegram(q), q).toBe(true);
    }
    expect(saysNoTelegram("Ассалому алейкум, нархаш чанд?")).toBe(false);
    expect(saysHasTelegram("телеграм дорам")).toBe(true);
    expect(saysHasTelegram("телеграм надорам")).toBe(false);
  });
  it("«бе телеграм намешад», «только в Telegram» — ответ задерживается фильтром", () => {
    expect(telegramOnlyIssues("Не апачон, бе телеграм намешад, дарсхо факат дар телеграм хастанд.")).toEqual(["telegram_only_claim"]);
    expect(telegramOnlyIssues("Уроки только в Telegram")).toEqual(["telegram_only_claim"]);
    expect(telegramOnlyIssues("Уроки в Telegram-группе или на нашем сайте")).toEqual([]);
  });
});

describe("п.5 реквизиты и «пришлите чек» не повторяются", () => {
  const base: RepeatContext = {
    phone: "905 355 355",
    requisitesSentRecently: false,
    receiptAskedRecently: false,
    paidWithAccess: false,
    hasAcceptedReceipt: false,
    clientAsksToPay: false,
  };
  const reply = "Ха, 70 сомони.\n905 355 355 Фарангис Чаборова (Алиф).\nЧекро фиристен.";
  it("номер уже был — второй раз его нет, остальное остаётся", () => {
    const r = withoutRepeats(reply, { ...base, requisitesSentRecently: true }, "tg");
    expect(r.text).toContain("70 сомони");
    expect(mentionsPaymentPhone(r.text, base.phone)).toBe(false);
  });
  it("человек переспросил номер, а он только что был — «номер выше», а не тишина", () => {
    const r = withoutRepeats("905 355 355 Фарангис Чаборова", { ...base, requisitesSentRecently: true }, "tg");
    expect(r.text).toBe("Номерро болотар навиштам");
  });
  it("оплатил и получил ссылку — чек не просим никогда", () => {
    const r = withoutRepeats("Рахмат! Чекро фиристед, дохил мекнем", { ...base, paidWithAccess: true }, "tg");
    expect(asksForReceipt(r.text)).toBe(false);
  });
  it("«чек получили» без принятого чека — не говорим (ложное «принято»)", () => {
    expect(claimsReceiptAccepted("Кабул кардем апачон, хозир дохил мекнем")).toBe(true);
    const r = withoutRepeats("Кабул кардем, хозир дохил мекнем", base, "tg");
    expect(r.text).toBe("");
    expect(r.removed).toContain("false_receipt_ack");
  });
  it("второй курс после первого — номер можно", () => {
    const r = withoutRepeats(reply, { ...base, paidWithAccess: true, clientAsksToPay: true }, "tg");
    expect(mentionsPaymentPhone(r.text, base.phone)).toBe(true);
  });
});

describe("п.7 не выдумывать", () => {
  it("выдумки из живых переписок ловятся фильтром", () => {
    for (const bad of [
      "Сертификат с вашим именем сам появится в программе",
      "Видео можно скачать на телефон",
      "Из Казахстана можно перевести на карту",
      "Ссылка придёт в течение часа",
      "Ссылка дар як соат меояд",
      "Простые печи не подходят",
    ]) {
      expect(unverifiedClaimIssues(bad), bad).toEqual(["unverified_claim"]);
    }
    expect(unverifiedClaimIssues("Печи Odul не подходят, нужна духовка с конвекцией")).toEqual([]);
    expect(replyPolicyIssues("Видео можно скачать", "Цены: 70 сомони.")).toContain("unverified_claim");
  });
  it("нет факта — метка [ASK_SHIRIN] в правилах и в ответе", () => {
    expect(ALWAYS_RULES).toContain("[ASK_SHIRIN]");
    expect(REPLY_POLICY_INSTRUCTION).toContain("[ASK_SHIRIN]");
    expect(isAskShirin("[ASK_SHIRIN]")).toBe(true);
  });
  it("«что после оплаты» и сертификат — без сроков и без «в программе»", () => {
    for (const t of [DEFAULT_SALES_TEXTS.afterPaymentRu, DEFAULT_SALES_TEXTS.afterPaymentTg, DEFAULT_SALES_TEXTS.certificateRuleRu, DEFAULT_SALES_TEXTS.certificateRuleTg]) {
      expect(unverifiedClaimIssues(t), t).toEqual([]);
    }
  });
  it("«Оид ба рецепт гуфта наметонам» — только на просьбу дать рецепт, не на вопрос о составе курса", () => {
    expect(guardOffTopic("апачон ячи прсмтон?аму онлайн арт десерто рецептои 5 6 донагиай ё рецептош калонай")).toBeNull();
    expect(guardOffTopic("Какие десерты входят в онлайн курс?")).toBeNull();
    expect(guardOffTopic("Рецепти чизкейк фиристед")?.kind).toBe("recipe_question");
    expect(guardOffTopic("сколько грамм желатина в чизкейк?")?.kind).toBe("recipe_question");
  });
  it("получатель — одно написание везде", () => {
    expect(DEFAULT_SALES_TEXTS.paymentRecipient).toBe("Фарангис Чаборова");
    expect(ALWAYS_RULES).not.toMatch(/Чабборова|Ҷабборова/);
  });
});

describe("п.10 промпт скрипта выкатки", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../../ops/2026-11-11-bot-texts.mjs"), "utf8");
  const prompt = /const NEW_PROMPT = `([\s\S]*?)`;/u.exec(script)?.[1] ?? "";
  it("короче прежнего (5,6 тыс.) и с нужными фактами", () => {
    expect(prompt.length).toBeGreaterThan(1500);
    expect(prompt.length).toBeLessThan(4500);
    for (const fact of ["70 сомони", "50 сомони", "100 сомони", "700 сомони", "8 дней", "13:40", "16:30", "Рудаки 177", "назди Воданасос", "905 355 355", "Фарангис Чаборова", "Telegram", "сайте", "[ASK_SHIRIN]", "[NO_REPLY]"]) {
      expect(prompt, fact).toContain(fact);
    }
  });
  it("без старых ошибок: 156/Додо, «бе телеграм», «апачон» как обращение, выдумки", () => {
    expect(prompt).not.toMatch(/Рудаки 156|Додо|бе телеграм намеш|Чабборова|Ҷабборова/iu);
    expect(prompt).not.toMatch(/Клиенток зовёшь|«Апачон»/u);
    expect(telegramOnlyIssues(prompt)).toEqual([]);
  });
  it("по умолчанию только показывает; запись — с APPLY=1", () => {
    expect(script).toContain('process.env.APPLY === "1"');
    expect(script).toContain("$transaction");
  });
});

describe("добавка владельца: фото меню, отзывы, смайлики", () => {
  it("ссылки меню — из настройки; мусор и не-https отброшены; пусто — запас", () => {
    expect(parseMenuMedia(null)).toEqual(DEFAULT_MENU_MEDIA);
    expect(parseMenuMedia("{oops")).toEqual(DEFAULT_MENU_MEDIA);
    const parsed = parseMenuMedia(JSON.stringify({ online70: ["https://a/x.jpg", "http://b/y.jpg", 5], offline: [] }));
    expect(parsed.online70).toEqual(["https://a/x.jpg"]);
    expect(parsed.offline).toEqual([]);
    expect(parsed.online50).toEqual(DEFAULT_MENU_MEDIA.online50);
  });
  it("отзывы — на сомнение и на «рост?», «натиҷа», «отзывы»", () => {
    for (const q of ["Рост мегуед?", "натичааш чи хел?", "Покажите отзывы", "кто уже учился?"]) {
      expect(asksForProof(q) || hasDoubtSignal(q), q).toBe(true);
    }
    expect(asksForProof("Нархаш чанд?")).toBe(false);
  });
  it("смайлик — изредка (≈1 из 3), никогда с цифрами (реквизиты)", () => {
    const texts = Array.from({ length: 300 }, (_, i) => `Хуб, саломат бошед вариант ${"а".repeat(i % 50)}${i}`.replace(/\d/g, "б"));
    const withEmoji = texts.filter((t) => maybeWarmEmoji(t, 3) !== t).length;
    expect(withEmoji).toBeGreaterThan(50);
    expect(withEmoji).toBeLessThan(170);
    expect(maybeWarmEmoji("905 355 355 Фарангис Чаборова", 1)).toBe("905 355 355 Фарангис Чаборова");
  });
});
