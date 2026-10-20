import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * aiReply — две дыры живого прогона 05.09.2026:
 *  1) на русский вопрос бот ответил по-таджикски — код должен перегенерировать
 *     один раз с прямым приказом, но не зацикливаться;
 *  2) на «я отправила чек» без картинки бот сказал «принято» — модель до такого
 *     сообщения доходить не должна вовсе.
 */
const generateWithFallback = vi.fn();
vi.mock("../../src/gemini.js", () => ({
  generateWithFallback: (...a: unknown[]) => generateWithFallback(...a),
  thinkingConfigFor: () => undefined,
}));

const sendToContact = vi.fn(async () => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));

vi.mock("../../src/instagram.js", () => ({ sendPrivateReply: vi.fn(), metaChannelOf: () => "INSTAGRAM" }));
vi.mock("../../src/upload.js", () => ({ saveReceiptImage: () => "/media/x.jpg" }));
vi.mock("../../src/ai/media.js", () => ({
  fetchAttachment: vi.fn(async () => null),
  buildMediaPart: vi.fn(async () => ({ inline_data: { mime_type: "image/jpeg", data: "" } })),
}));
vi.mock("../../src/ai/receiptCheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ai/receiptCheck.js")>()),
  checkReceipt: vi.fn(async () => null),
}));
vi.mock("../../src/ai/receiptVerdict.js", () => ({ handleReceiptVerdict: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: vi.fn(async () => []) }));
vi.mock("../../src/receiptRetry.js", () => ({ queueUncheckedReceipt: vi.fn(async () => null) }));
vi.mock("../../src/aiReplyRetry.js", () => ({ queuePendingAiReply: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/aiLog.js", () => ({ logAiCall: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key"]) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ buildStyleBlock: vi.fn(async () => "") }));
vi.mock("../../src/nightlyLearning.js", () => ({ buildInsightsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/objectionLibrary.js", () => ({ buildObjectionsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/mediaReuse.js", () => ({ findReusableMedia: vi.fn(async () => null), sendReusedMedia: vi.fn() }));
vi.mock("../../src/ai/menuImages.js", () => ({ sendMenuImages: vi.fn() }));
vi.mock("../../src/ai/testimonials.js", () => ({ maybeSendTestimonial: vi.fn(async () => undefined) }));
vi.mock("../../src/learningCheckIn.js", () => ({ markStartedLearningIfReplied: vi.fn(async () => undefined) }));
vi.mock("../../src/stuckAlert.js", () => ({ notifyIfStuck: vi.fn(async () => undefined) }));
vi.mock("../../src/course/recovery.js", () => ({ maybeRestoreAccess: vi.fn(async () => ({ handled: false })) }));
vi.mock("../../src/ai/offlineSignup.js", () => ({ registerOfflineSignup: vi.fn(async () => false) }));
vi.mock("../../src/ai/offlineCourse.js", () => ({ maybeSendOfflineCard: vi.fn(async () => false) }));
vi.mock("../../src/ai/courseDate.js", () => ({ courseDateLabel: vi.fn(async () => "") }));
vi.mock("../../src/ai/dailyBudget.js", () => ({
  isBudgetExceeded: vi.fn(async () => false),
  recordAiCall: vi.fn(async () => undefined),
}));
vi.mock("../../src/courses.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/courses.js")>()),
  ownedCourses: vi.fn(async () => []),
}));

import { aiReply } from "../../src/ai.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { aiEnabled: "true" };

function said(text: string) {
  return { text, model: "gemini-3.7-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

/** Системный промт N-го вызова модели. */
function systemPromptOfCall(n: number): string {
  const build = generateWithFallback.mock.calls[n][2] as (m: string) => string;
  return JSON.parse(build("m")).system_instruction.parts[0].text as string;
}

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null
  );
  db.model("message").findMany.mockResolvedValue([]);
  db.model("message").count.mockResolvedValue(5);
  db.model("purchase").count.mockResolvedValue(0);
  generateWithFallback.mockReset();
  sendToContact.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

const web = fakeContact({ channel: "WEB" }) as Parameters<typeof aiReply>[0];

describe("«Я отправила чек» без картинки", () => {
  it("ГЛАВНОЕ: модель не зовём, отвечаем «чек пока не вижу» на языке клиентки", async () => {
    await aiReply(web, "Я оплатила, отправила чек, когда придёт ссылка?", [], []);

    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toContain("Чек пока не вижу");
    expect(db.model("message").create).toHaveBeenCalledTimes(1);
  });

  it("по-таджикски — тот же ответ по-таджикски", async () => {
    await aiReply(web, "Чекро фиристодам, пайванд кай меояд?", [], []);
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(String(sendToContact.mock.calls[0][1])).toContain("Чекро ҳоло намебинам");
  });

  it("а с картинкой — обычный путь через модель", async () => {
    generateWithFallback.mockResolvedValue(said("Сейчас посмотрю чек."));
    const rescued = { buffer: Buffer.from("x"), mimeType: "image/jpeg", hash: "h", url: "/media/x.jpg", queuedId: null };
    await aiReply(web, "отправила чек", [{ url: "/media/x.jpg", kind: "image" }], [rescued]);

    expect(generateWithFallback).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toBe("Сейчас посмотрю чек.");
  });
});

describe("Язык ответа проверяет код", () => {
  it("ГЛАВНОЕ: русский вопрос, таджикский ответ — один повтор с приказом, уходит русский", async () => {
    generateWithFallback
      .mockResolvedValueOnce(said("Кабул кардем апачон, хозир дохил мекнем"))
      .mockResolvedValueOnce(said("Курс стоит 70 сомони, апачон."));

    await aiReply(web, "Здравствуйте, сколько стоит курс?", [], []);

    expect(generateWithFallback).toHaveBeenCalledTimes(2);
    expect(systemPromptOfCall(0)).not.toContain("СРОЧНОЕ ИСПРАВЛЕНИЕ");
    expect(systemPromptOfCall(1)).toContain("Отвечай ТОЛЬКО на русском");
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toBe("Курс стоит 70 сомони, апачон.");
  });

  it("и наоборот: таджикский вопрос, русский ответ — повтор по-таджикски", async () => {
    generateWithFallback
      .mockResolvedValueOnce(said("Курс стоит 70 сомони."))
      .mockResolvedValueOnce(said("Нархаш 70 сомони, апачон, чекро фиристед"));

    await aiReply(web, "Нархи курс чанд аст?", [], []);

    expect(generateWithFallback).toHaveBeenCalledTimes(2);
    expect(systemPromptOfCall(1)).toContain("ТОЛЬКО по-таджикски");
    expect(String(sendToContact.mock.calls[0][1])).toContain("Нархаш 70 сомони");
  });

  it("снова не тот язык — не зацикливаемся: отдаём повторный ответ и пишем предупреждение", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateWithFallback
      .mockResolvedValueOnce(said("Кабул кардем апачон, хозир дохил мекнем"))
      .mockResolvedValueOnce(said("Ҳо, мешавад апачон"));

    await aiReply(web, "Можно с двух телефонов?", [], []);

    expect(generateWithFallback).toHaveBeenCalledTimes(2);
    expect(String(sendToContact.mock.calls[0][1])).toBe("Ҳо, мешавад апачон");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ai:languageMismatch"))).toBe(true);
  });

  it("язык совпал — один вызов, ничего лишнего", async () => {
    generateWithFallback.mockResolvedValue(said("Курс стоит 70 сомони, апачон."));
    await aiReply(web, "Сколько стоит курс?", [], []);
    expect(generateWithFallback).toHaveBeenCalledTimes(1);
  });

  it("правило про личную ссылку и 2 устройства — в промте всегда", async () => {
    generateWithFallback.mockResolvedValue(said("Два устройства — да, но только свои."));
    await aiReply(web, "Можно с двух телефонов, моего и сестры?", [], []);
    expect(systemPromptOfCall(0)).toContain("на 2 его устройствах");
    expect(systemPromptOfCall(0)).toContain("ссылка личная");
  });
});

describe("Контекст офлайн-курса держится по обеим сторонам переписки (владелец 06.09.2026)", () => {
  /** message.findMany вызывается и для истории модели (без select), и для
   *  recentIncomingWantsOffline (select: {text}) — различаем по select. */
  function mockRecentMessages(texts: string[]) {
    db.model("message").findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: { text?: boolean } };
      return a?.select?.text ? texts.map((text) => ({ text })) : [];
    });
  }

  it("бот сам упомянул офлайн несколько ходов назад, клиент спрашивает «когда» без слова — дата всё равно уходит в промт", async () => {
    mockRecentMessages([
      "Дида",
      "Кай рафта мешава",
      "Ҳо апаҷон, мешавад. Ҳамаи дарсҳо аз нол нишон дода шудаанд.",
      "Дар телеграм видео равон кардагира дида пухта мешава",
      "Сурога: шаҳри Душанбе, хиёбони Рӯдакӣ 156.",
      "Дар кадом тараф боша",
      "Агар вактатон кам бошад, онлайнаш хеле кулай аст.",
      "офлайн курс хеле хуб аст — хамаашро аз наздик мепазед",
    ]);
    generateWithFallback.mockResolvedValue(said("Курси офлайн 3 октябр сар мешавад."));

    await aiReply(web, "Кай мешавад?", [], []);

    expect(systemPromptOfCall(0)).toContain("ВАЖНО СЕЙЧАС: человек хочет на ОФЛАЙН-курс");
  });

  it("без офлайн-контекста в недавней переписке — блока про офлайн-курс нет", async () => {
    mockRecentMessages(["Здравствуйте", "Добрый день! Чем помочь?"]);
    generateWithFallback.mockResolvedValue(said("Ассалому алейкум!"));

    await aiReply(web, "Кай мешавад?", [], []);

    expect(systemPromptOfCall(0)).not.toContain("ОФЛАЙН-курс");
  });
});
