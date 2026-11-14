import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
import {
  humanizeBotText,
  plainTajikLetters,
  withoutDashes,
  withoutAddressWords,
  withoutStockTails,
  comparableBotText,
  FORBIDDEN_IN_PLAIN_BOT_TEXT,
} from "../../src/ai/humanText.js";

const sendText = vi.fn(async () => "mid-meta");
vi.mock("../../src/instagram.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/instagram.js")>();
  return { ...actual, sendText: (...a: unknown[]) => sendText(...(a as [])) };
});
vi.mock("../../src/greeting.js", () => ({ stripRepeatGreeting: async (_id: string, t: string) => t }));
vi.mock("../../src/voice.js", () => ({ toOwnerVoice: (t: string) => t }));

import { sendToContact } from "../../src/messaging/send.js";
import { BUDGET_FALLBACK, DEFAULT_SALES_TEXTS } from "../../src/ai/prompts.js";
import { clarifyText } from "../../src/ai/relevance.js";
import { receiptNotSeenReply } from "../../src/ai/receiptClaim.js";
import { guardReply, isGuardReply, type GuardKind } from "../../src/ai/offTopicGuard.js";
import {
  offlineCardDefault,
  offlineCardMessages,
  OFFLINE_DATE_TBD,
  DEFAULT_OFFLINE_FACTS,
} from "../../src/ai/offlineCourse.js";
import { reminderText } from "../../src/offlineReminder.js";
import { DELIVERY_QUESTION } from "../../src/course/deliveryChoice.js";
import { accessMessage } from "../../src/course/delivery.js";
import { REJECT_TEXT } from "../../src/receiptDecision.js";
import { PHONE_CHANGE_TEXT } from "../../src/course/phoneChange.js";
import { DEFAULT_QUICK_REPLIES } from "../../src/quickReplies.js";

const PLAIN = { keepTajikLetters: false };
const KEEP = { keepTajikLetters: true };

describe("фильтр текста бота (владелец 08.11.2026: «пишет как бот»)", () => {
  it("особые буквы → обычные, с регистром; «и» + знак долготы тоже", () => {
    expect(plainTajikLetters("Ҷавоб қабул ҳамин ғам кӯча ширинӣ ӮҒҚҲҶӢ")).toBe(
      "Чавоб кабул хамин гам куча ширини УГКХЧИ",
    );
    expect(plainTajikLetters("шириӣ")).toBe("ширии");
  });

  it("клиент пишет особыми буквами — оставляем; без них — меняем", () => {
    expect(humanizeBotText("Ҳа, мешавад", KEEP)).toBe("Ҳа, мешавад");
    expect(humanizeBotText("Ҳа, мешавад", PLAIN)).toBe("Ха, мешавад");
  });

  it("тире: между словами — запятая, в начале строки — ничего, между цифрами — дефис", () => {
    expect(withoutDashes("Курс — 700 сомони")).toBe("Курс, 700 сомони");
    expect(withoutDashes("Сертификат выдаётся, — прямо в приложении")).toBe("Сертификат выдаётся, прямо в приложении");
    expect(withoutDashes("— первый пункт\n– второй пункт")).toBe("первый пункт\nвторой пункт");
    expect(withoutDashes("с 13:40–16:30 и 13:40 — 16:30")).toBe("с 13:40-16:30 и 13:40-16:30");
    expect(withoutDashes("Да. — Нет")).toBe("Да. Нет");
    expect(withoutDashes("Чек получила —")).toBe("Чек получила");
    expect(withoutDashes("арт-десерты и т.д…")).toBe("арт-десерты и т.д…"); // дефис и многоточие не трогаем
  });

  it("«апачон/апа» убирается целым словом, остальное не страдает", () => {
    expect(withoutAddressWords("Салом апачон, курс 50 сомони")).toBe("Салом, курс 50 сомони");
    expect(withoutAddressWords("Апачон, курс 50 сомони")).toBe("Курс 50 сомони");
    expect(withoutAddressWords("Хуб, апа.")).toBe("Хуб.");
    expect(withoutAddressWords("Капалак и папа")).toBe("Капалак и папа");
  });

  it("дежурный хвост срезается, только если до него есть сам ответ", () => {
    expect(withoutStockTails("Курс стоит 70 сомони. Если будут вопросы, пишите!")).toBe("Курс стоит 70 сомони.");
    expect(withoutStockTails("Ссылка выше. Обращайтесь")).toBe("Ссылка выше.");
    expect(withoutStockTails("Если будут вопросы, пишите")).toBe("Если будут вопросы, пишите");
    expect(withoutStockTails("Если будут вопросы по оплате, номер ниже. Курс 70")).toBe(
      "Если будут вопросы по оплате, номер ниже. Курс 70",
    );
  });

  it("идемпотентен: повторная правка ничего не меняет", () => {
    const once = humanizeBotText("Ассалому алейкум апачон — курс ҳаст. Если будут вопросы, обращайтесь", PLAIN);
    expect(once).toBe("Ассалому алейкум, курс хаст.");
    expect(humanizeBotText(once, PLAIN)).toBe(once);
  });
});

describe("дверь отправки: всё, что пишет бот, проходит фильтр; слова Ширин — нет", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findUnique.mockResolvedValue(fakeContact());
    sendText.mockClear().mockResolvedValue("mid-meta");
  });
  afterEach(restorePrisma);

  it("клиент пишет без особых букв — бот тоже; тире и «апачон» не уходят", async () => {
    db.model("message").findMany.mockResolvedValue([{ text: "Салом курс чанд пул" }]);
    await sendToContact(fakeContact() as never, "Ҳа апачон — курс 50 сомони");
    expect(sendText.mock.calls[0][1]).toBe("Ха, курс 50 сомони");
  });

  it("по умолчанию (владелец 11.11.2026) без книжных букв, даже если клиент пишет ими", async () => {
    db.model("message").findMany.mockResolvedValue([{ text: "Курс чанд пул? Ҳаст?" }]);
    await sendToContact(fakeContact() as never, "Ҳа — курс ҳаст");
    expect(sendText.mock.calls[0][1]).toBe("Ха, курс хаст");
  });

  it("tajikLettersMode=mirror — буквы как у клиента остаются, тире всё равно нет", async () => {
    db.model("setting").findUnique.mockImplementation(async (args: unknown) =>
      (args as { where: { key: string } }).where.key === "tajikLettersMode"
        ? { key: "tajikLettersMode", value: "mirror" }
        : null,
    );
    db.model("message").findMany.mockResolvedValue([{ text: "Курс чанд пул? Ҳаст?" }]);
    await sendToContact(fakeContact() as never, "Ҳа — курс ҳаст");
    expect(sendText.mock.calls[0][1]).toBe("Ҳа, курс ҳаст");
  });

  it("сообщение Ширин (byHuman) уходит как она написала", async () => {
    await sendToContact(fakeContact() as never, "Ҳа апачон — пагоҳ", [], { byHuman: true });
    expect(sendText.mock.calls[0][1]).toBe("Ҳа апачон — пагоҳ");
  });

  it("стиль клиента не узнали (сбой базы) — пишем без особых букв", async () => {
    db.model("message").findMany.mockRejectedValue(new Error("db down"));
    await sendToContact(fakeContact() as never, "Ҳа");
    expect(sendText.mock.calls[0][1]).toBe("Ха");
  });
});

describe("класс: ни один зашитый шаблон не уходит клиенту с тире, особыми буквами или смайликом", () => {
  const LANGS = ["ru", "tg", "en"] as const;
  const KINDS: Exclude<GuardKind, "freeloader">[] = [
    "probing",
    "asks_bot",
    "offtopic",
    "task_request",
    "recipe_question",
    "no_such_course",
    "order_request",
    "wants_human",
  ];
  const DATE = { year: 2026, month: 11, day: 20 };

  /** Шаблоны, которые идут через дверь sendToContact (фильтр применится). */
  const viaDoor: string[] = [
    ...LANGS.map((l) => BUDGET_FALLBACK[l]),
    ...LANGS.map((l) => clarifyText(l)),
    ...LANGS.flatMap((l) => [receiptNotSeenReply(l, true), receiptNotSeenReply(l, false)]),
    ...LANGS.flatMap((l) =>
      KINDS.flatMap((k) => [guardReply(k, l), guardReply(k, l, true, "web"), guardReply(k, l, true, "telegram")]),
    ),
    ...(["ru", "tg"] as const).flatMap((l) => [
      ...offlineCardMessages(offlineCardDefault(l, DATE)),
      ...offlineCardMessages(offlineCardDefault(l, null, { ...DEFAULT_OFFLINE_FACTS, seats: 8 })),
      OFFLINE_DATE_TBD[l],
      reminderText(l, "Нигина", DEFAULT_OFFLINE_FACTS),
      reminderText(l, "", DEFAULT_OFFLINE_FACTS),
    ]),
  ];

  /** Шаблоны, которые могут уйти по кнопке Ширин (byHuman) — мимо фильтра:
   *  они обязаны быть чистыми сами по себе. */
  const pastDoor: string[] = [
    ...LANGS.map((l) => REJECT_TEXT[l]),
    DELIVERY_QUESTION.ru,
    DELIVERY_QUESTION.tg,
    ...LANGS.flatMap((l) => Object.values(PHONE_CHANGE_TEXT[l])),
    ...DEFAULT_QUICK_REPLIES.map((q) => q.text),
    ...(["ru", "tg", "en"] as const).flatMap((language) =>
      [
        accessMessage({
          courseTitle: "21 рецепт",
          telegramLink: null,
          webLink: "https://x/c/1",
          withTitle: true,
          language,
        }),
        accessMessage({
          courseTitle: "21 рецепт",
          telegramLink: null,
          webLink: "https://x/c/1",
          withTitle: false,
          language,
          added: true,
        }),
        accessMessage({
          courseTitle: "21 рецепт",
          telegramLink: "https://t.me/+a",
          webLink: "https://x/c/1",
          withTitle: false,
          language,
        }),
      ].filter((t): t is string => Boolean(t)),
    ),
  ];

  it("через дверь: после фильтра для клиента без особых букв — ни тире, ни ҷқӯғҳӣ", () => {
    const bad = viaDoor.map((t) => humanizeBotText(t, PLAIN)).filter((t) => FORBIDDEN_IN_PLAIN_BOT_TEXT.test(t));
    expect(bad).toEqual([]);
  });

  it("мимо двери (кнопка Ширин): чистые уже в исходнике — без тире, ҷқӯғҳӣ и смайликов", () => {
    const bad = pastDoor.filter((t) => FORBIDDEN_IN_PLAIN_BOT_TEXT.test(t) || /\p{Extended_Pictographic}/u.test(t));
    expect(bad).toEqual([]);
  });

  it("зашитые таджикские шаблоны — без книжных слов и без «апачон»", () => {
    const tg = [...viaDoor, ...pastDoor].join("\n");
    expect(tg).not.toMatch(/мутаассифона|лутфан|мебошад|апачон|апаҷон|хоҳиш мекунем/iu);
  });

  it("образцы для модели (тексты продаж) — без длинных тире", () => {
    // Строка цен собирается в prices.ts (своя дверь и свои тесты); ответ модели с ней всё равно идёт через фильтр.
    const { priceLineRu: _priceLine, ...samples } = DEFAULT_SALES_TEXTS;
    for (const value of Object.values(samples)) expect(value).not.toMatch(/[—–]/);
  });
});

describe("архитектура: текст бота уходит наружу только через фильтр", () => {
  const root = path.resolve("src");
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
      );

  it("ответ на комментарий (мимо sendToContact) зовут только ai.ts и funnel.ts, и оба правят текст фильтром", () => {
    const callers = files(root)
      .filter((f) => /\bsendPrivateReply\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).replaceAll("\\", "/"))
      .filter((f) => f !== "instagram.ts")
      .sort();
    expect(callers).toEqual(["ai.ts", "funnel.ts"]);
    for (const f of callers) expect(fs.readFileSync(path.join(root, f), "utf8")).toContain("humanizeForContact(");
  });

  it("текст напрямую в транспорт (мимо двери) уходит только из send.ts; admin.ts — ручная отправка Ширин", () => {
    const callers = (re: RegExp, own: string[]) =>
      files(root)
        .filter((f) => re.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(root, f).replaceAll("\\", "/"))
        .filter((f) => !own.includes(f))
        .sort();
    expect(callers(/\bsendText\(/, ["instagram.ts"])).toEqual(["admin.ts", "messaging/send.ts"]);
    expect(callers(/\bsendWhatsApp(?:Text|Attachment)\(/, ["whatsapp/transport.ts"])).toEqual(["messaging/send.ts"]);
    // Ручная отправка в admin.ts — это Ширин (разрешение "human"), фильтр к ней не применяется.
    expect(fs.readFileSync(path.join(root, "admin.ts"), "utf8")).toContain(
      'withMessagingPermission("human", () => sendText(',
    );
  });

  it("подпись к видео в WhatsApp идёт через тот же фильтр, что и текст", () => {
    const send = fs.readFileSync(path.join(root, "messaging/send.ts"), "utf8");
    const fn = send.slice(send.indexOf("export async function sendVideoWithCaption"));
    expect(fn.slice(0, fn.search(/\r?\n\}\r?\n/))).toContain(
      "humanizeForContact(contact.id, cleanKeepingWarmTail(caption))",
    );
  });

  it("sendToContact правит всё, что написала не Ширин", () => {
    expect(fs.readFileSync(path.join(root, "messaging/send.ts"), "utf8")).toContain(
      "if (!opts.byHuman) text = await humanizeForContact(contact.id, cleanKeepingWarmTail(text))",
    );
  });

  it("карта замен особых букв — одна (ai/humanText.ts), без копий по коду", () => {
    const copies = files(root)
      .filter((f) => /replace\(\/ҷ\/g|ҷ:\s*"ч"/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).replaceAll("\\", "/"));
    expect(copies).toEqual(["ai/humanText.ts"]);
  });
});

describe("ревью 08.11.2026: правки фильтра", () => {
  it("несколько дежурных хвостов подряд срезаются за один проход — повторная правка ничего не меняет", () => {
    const once = humanizeBotText("Курс 50 сомони. Всегда рада помочь. Обращайтесь.", PLAIN);
    expect(once).toBe("Курс 50 сомони.");
    expect(humanizeBotText(once, PLAIN)).toBe(once);
    expect(withoutStockTails("Если будут вопросы, пишите")).toBe("Если будут вопросы, пишите");
  });

  it("обращение через дефис уходит целиком, без хвоста «-чон»", () => {
    expect(withoutAddressWords("Апа-ҷон, салом")).toBe("Салом");
    expect(withoutAddressWords("Салом апа-джан! Курс 50")).toBe("Салом! Курс 50");
    expect(withoutAddressWords("Апаи Ширин мегӯяд")).toBe("Апаи Ширин мегӯяд");
  });

  it("сравнение с историей: старая строка (тире, особые буквы, точка) = новая", () => {
    expect(comparableBotText("Хорошо — сейчас Ширин сама вам ответит.")).toBe(
      comparableBotText("Хорошо, сейчас Ширин сама вам ответит"),
    );
    expect(comparableBotText("Ин порчаи видеодарс: Ҳамин ❤️")).toBe(comparableBotText("Ин порчаи видеодарс: хамин"));
  });

  it("старые шаблоны в истории засчитываются: ответ про рецепты второй раз не уйдёт", () => {
    // Тексты до 08.11.2026, как они лежат в истории.
    expect(
      isGuardReply(
        "По рецептам у нас чат в телеграм-группе — напишите туда, там отвечаем на все вопросы",
        "recipe_question",
      ),
    ).toBe(true);
    expect(isGuardReply("Саволҳои рецепт дар чати гурӯҳи телеграми мо — ҳамон ҷо нависед", "recipe_question")).toBe(
      true,
    );
    expect(
      isGuardReply(
        "Откройте ваш урок в личном кабинете и нажмите «Вопрос» — Ширин увидит, о каком рецепте речь",
        "recipe_question",
      ),
    ).toBe(true);
    expect(isGuardReply("К сожалению нет — у нас только кондитерские курсы")).toBe(true);
    // Новый шаблон после фильтра отправки (тире на сайте становится запятой).
    expect(isGuardReply(humanizeBotText(guardReply("recipe_question", "en", true), PLAIN), "recipe_question")).toBe(
      true,
    );
    expect(
      isGuardReply(humanizeBotText(guardReply("recipe_question", "ru", true, "web"), PLAIN), "recipe_question"),
    ).toBe(true);
    // Чужой текст — не шаблон.
    expect(isGuardReply("Курс стоит 70 сомони")).toBe(false);
    expect(isGuardReply("")).toBe(false);
  });
});
