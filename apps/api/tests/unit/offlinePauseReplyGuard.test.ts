import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
import { explicitOfflineInterest, replyHasOfflineFacts } from "../../src/ai/offlineHandoff.js";
import { DEFAULT_OFFLINE_FACTS } from "../../src/ai/offlineFacts.js";

const F = DEFAULT_OFFLINE_FACTS;

/**
 * Пауза «по офлайн-курсам не отвечаем» (offlineRepliesPaused) протекала (переписки 24.11.2026):
 * девушка написала «живой курс» — входной фильтр не узнал офлайн, и модель сама выдала
 * цену 700, адрес и дату старта (ещё и с чужим временем занятий). Два слоя:
 * «живой курс» теперь офлайн на входе; ответ модели с фактами офлайна не уходит —
 * разговор передаётся Ширин (offlineHandoffAt), сторож напоминает ей в Telegram.
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
vi.mock("../../src/ai/relevanceGate.js", () => ({ passesRelevanceGate: vi.fn(async () => true) }));
vi.mock("../../src/ai/reactions.js", () => ({ reactInsteadOfReply: vi.fn(async () => false) }));
vi.mock("../../src/voice.js", () => ({ maybeWarmEmoji: (t: string) => t }));
vi.mock("../../src/ai/styleLearning.js", () => ({ buildStyleBlock: vi.fn(async () => "") }));
vi.mock("../../src/nightlyLearning.js", () => ({ buildInsightsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/objectionLibrary.js", () => ({ buildObjectionsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/mediaReuse.js", () => ({ findReusableMedia: vi.fn(async () => null), sendReusedMedia: vi.fn() }));
vi.mock("../../src/ai/menuImages.js", () => ({
  sendMenuImages: vi.fn(),
  maybeSendCourseMenuPhoto: vi.fn(async () => undefined),
  sendOfflineMenuPhoto: vi.fn(async () => undefined),
}));
vi.mock("../../src/ai/testimonials.js", async (original) => ({
  ...(await original<typeof import("../../src/ai/testimonials.js")>()),
  maybeSendTestimonial: vi.fn(async () => undefined),
}));
vi.mock("../../src/learningCheckIn.js", () => ({ markStartedLearningIfReplied: vi.fn(async () => undefined) }));
vi.mock("../../src/stuckAlert.js", () => ({ notifyIfStuck: vi.fn(async () => undefined) }));
vi.mock("../../src/course/recovery.js", () => ({ maybeRestoreAccess: vi.fn(async () => ({ handled: false })) }));
vi.mock("../../src/ai/offlineSignup.js", () => ({
  registerOfflineSignup: vi.fn(async () => false),
  extractPhone: (t: string) => (/9[0-9]{8}/.exec(t ?? "") ?? [null])[0],
}));
vi.mock("../../src/ai/offlineCourse.js", async (original) => ({
  ...(await original<typeof import("../../src/ai/offlineCourse.js")>()),
  maybeSendOfflineCard: vi.fn(async () => false),
}));
vi.mock("../../src/ai/courseDate.js", async (original) => ({
  ...(await original<typeof import("../../src/ai/courseDate.js")>()),
  courseDateLabel: vi.fn(async () => ""),
  upcomingOfflineStartDate: vi.fn(async () => null),
}));
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
let SETTINGS: Record<string, string>;

function said(text: string) {
  return { text, model: "gemini-3.7-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

// Почти дословно ответ модели из переписки 24.11.2026 (без личных данных).
const OFFLINE_REPLY = `Офлайн-курс дар Душанбе ${DEFAULT_OFFLINE_FACTS.price} сомони, ${DEFAULT_OFFLINE_FACTS.days} руз давом мекунад, махсулот аз худамон. Аз 7 декабр сар мешавад. Сурога: ${DEFAULT_OFFLINE_FACTS.address}`;

beforeEach(() => {
  SETTINGS = { aiEnabled: "true", offlineRepliesPaused: "true" };
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
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

const ig = fakeContact({ channel: "INSTAGRAM" }) as Parameters<typeof aiReply>[0];
const sentTexts = () => sendToContact.mock.calls.map((c) => String((c as unknown[])[1]));
const handedToShirin = () =>
  db
    .model("contact")
    .update.mock.calls.some((c) => Boolean((c[0] as { data?: { offlineHandoffAt?: unknown } }).data?.offlineHandoffAt));

describe("вход: «живой курс» — это офлайн", () => {
  it.each(["живой курс", "А живой курс есть?", "хочу на живые занятия", "курси зинда доред?", "зинда курс кай"])(
    "%s",
    (t) => expect(explicitOfflineInterest(t)).toBe(true),
  );
  it.each(["онлайн курс живой интересный?", "жить без сладкого не могу", "Зиндагӣ хуб"])("не офлайн: %s", (t) =>
    expect(explicitOfflineInterest(t)).toBe(false),
  );

  it("при паузе на «живой курс» бот молчит и модель не зовёт", async () => {
    await aiReply(ig, "живой курс", [], []);
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

describe("выход: ответ с фактами офлайна при паузе не уходит", () => {
  it("факты офлайна в ответе узнаются", () => {
    expect(replyHasOfflineFacts(OFFLINE_REPLY, F)).toBe(true);
    expect(replyHasOfflineFacts("Курс стоит 700 сомони", F)).toBe(true);
    expect(replyHasOfflineFacts("Старт 7 декабря", F)).toBe(true);
    expect(replyHasOfflineFacts(`Сурога: ${F.address}`, F)).toBe(true);
    expect(replyHasOfflineFacts("курс 8 руз давом мекунад", F)).toBe(true);
  });

  it("уточняющий вопрос и онлайн-цены — не офлайн-факты", () => {
    expect(replyHasOfflineFacts("Вам интересен онлайн-курс или офлайн в Душанбе?", F)).toBe(false);
    expect(
      replyHasOfflineFacts("Онлайн 21 рецепт 70 сомони, Арт-десертхо 50 сомони, ё офлайн курс дар Душанбе?", F),
    ).toBe(false);
    expect(replyHasOfflineFacts("Карта 905355355, 100 сомони за оба курса", F)).toBe(false);
  });

  it("ГЛАВНОЕ: модель выдала офлайн на нейтральный вопрос — не отправляем, передаём Ширин", async () => {
    generateWithFallback.mockResolvedValue(said(OFFLINE_REPLY));
    await aiReply(ig, "иштирок кардан дар курстон", [], []);
    expect(generateWithFallback).toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes(F.address) || /декабр/i.test(t))).toBe(false);
    expect(handedToShirin()).toBe(true);
  });

  it("пауза выключена — тот же ответ уходит как раньше", async () => {
    SETTINGS.offlineRepliesPaused = "";
    generateWithFallback.mockResolvedValue(said(OFFLINE_REPLY));
    await aiReply(ig, "иштирок кардан дар курстон", [], []);
    expect(sentTexts().some((t) => t.includes(F.address))).toBe(true);
    expect(handedToShirin()).toBe(false);
  });

  it("онлайн-ответ при паузе уходит как обычно", async () => {
    generateWithFallback.mockResolvedValue(said("Курси «21 рецепт» 70 сомони ва «Арт-десертхо» 50 сомони"));
    await aiReply(ig, "Нархаш чанд", [], []);
    expect(sentTexts().join(" ")).toContain("70 сомони");
    expect(handedToShirin()).toBe(false);
  });
});
