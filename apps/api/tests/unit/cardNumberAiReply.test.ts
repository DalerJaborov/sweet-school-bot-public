import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";
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

/**
 * НОМЕР КАРТЫ СРАЗУ — ход aiReply целиком (разбор 16.11.2026, пункт 1).
 * После #86 бот на «чанд?» отвечал «Хотите, реквизиты отправлю?», и номер получали
 * 1–3 человека в день вместо 7–17. Здесь: цена и номер одним сообщением, вопрос
 * «отправить реквизиты?» не уходит, «не надо / позже» номер больше не тащит.
 */
import { aiReply } from "../../src/ai.js";
import { resetRequisitesClaims } from "../../src/ai/repeatGuard.js";

let db: PrismaMock;
const SETTINGS: Record<string, string> = { aiEnabled: "true" };
const PHONE = /905\s?355\s?355/;

function said(text: string) {
  return { text, model: "gemini-3.7-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

/** История клиента (IN) для проверки «не надо / позже». */
let incoming: { text: string; createdAt: Date }[] = [];

beforeEach(() => {
  resetRequisitesClaims();
  incoming = [];
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("message").findMany.mockImplementation(async (args: { where?: { direction?: string } }) =>
    args?.where?.direction === "IN" ? incoming : [],
  );
  db.model("message").count.mockResolvedValue(5);
  db.model("purchase").count.mockResolvedValue(0);
  db.model("purchase").findMany.mockResolvedValue([]);
  generateWithFallback.mockReset();
  sendToContact.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

const ig = fakeContact({ channel: "INSTAGRAM" }) as Parameters<typeof aiReply>[0];
const sent = () => sendToContact.mock.calls.map((c) => String((c as unknown[])[1]));

describe("(б) спросил цену — цена и номер одним сообщением", () => {
  it("ГЛАВНОЕ: «чанд сомонӣ?» — одно сообщение с ценой и номером, без «реквизиты отправить?»", async () => {
    generateWithFallback.mockResolvedValue(said("21 рецепт 70 сомонӣ. Хотите, реквизиты отправлю?"));
    await aiReply(ig, "чанд сомонӣ?", [], []);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    const [msg] = sent();
    expect(msg).toContain("70");
    expect(msg).toMatch(PHONE);
    expect(msg).toContain("Фарангис Чаборова");
    expect(msg).not.toMatch(/отправлю\?|реквизит\p{L}*\s+отправ/iu);
  });

  it("таджикский вопрос-предложение тоже вырезается: «Рақами кортро фиристам?» → сразу номер", async () => {
    generateWithFallback.mockResolvedValue(said("Нархаш 70 сомонӣ.\n---\nРақами кортро фиристам?"));
    await aiReply(ig, "21 рецепт нархаш чанд", [], []);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toMatch(PHONE);
    expect(sent()[0]).not.toContain("фиристам?");
  });

  it("выбрал курс без вопроса («21 рецепт») — модель цену не назвала: код добавляет и цену, и номер", async () => {
    generateWithFallback.mockResolvedValue(said("Хороший выбор, там 21 десерт с видео."));
    await aiReply(ig, "21 рецепт", [], []);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/21 рецепт 70 сомони/);
    expect(sent()[0]).toMatch(PHONE);
  });

  it("посторонний вопрос (сертификат) — номер к ответу не приклеивается", async () => {
    generateWithFallback.mockResolvedValue(said("Да, сертификат входит в стоимость."));
    await aiReply(ig, "А сертификат будет?", [], []);
    expect(sent().join("\n")).not.toMatch(PHONE);
  });

  it("про офлайн-курс номер карты не даём", async () => {
    generateWithFallback.mockResolvedValue(said("Офлайн-курс в Душанбе, запись у Ширин."));
    await aiReply(ig, "офлайн курс чанд пул?", [], []);
    expect(sent().join("\n")).not.toMatch(PHONE);
  });

  it("номер только что ушёл шагом воронки (захват) — второй раз в ответе не появляется", async () => {
    const { tryClaimRequisites } = await import("../../src/ai/repeatGuard.js");
    expect(tryClaimRequisites("contact-1")).toBe(true); // шаг воронки взял номер
    generateWithFallback.mockResolvedValue(said("Да, 70 сомони, доступ навсегда."));
    await aiReply(ig, "70 сомони за день?", [], []);
    expect(sent().join("\n")).not.toMatch(PHONE);
  });
});

describe("(в) «не надо, позже» — номер не навязываем", () => {
  it("после «не надо, позже» на «сколько стоит» номер не добавляется, а модельный — вырезается", async () => {
    incoming = [
      { text: "21 рецепт", createdAt: new Date(Date.now() - 3_600_000) },
      { text: "не надо, позже", createdAt: new Date(Date.now() - 1_800_000) },
    ];
    generateWithFallback.mockResolvedValue(said("Хорошо. Доступ навсегда. Номер карты 905 355 355."));
    await aiReply(ig, "а доступ навсегда?", [], []);
    expect(sent().join("\n")).not.toMatch(PHONE);
  });

  it("но сам спросил «куда переводить» — номер снова можно", async () => {
    incoming = [{ text: "не надо, позже", createdAt: new Date(Date.now() - 3_600_000) }];
    generateWithFallback.mockResolvedValue(said("Сюда, пожалуйста."));
    await aiReply(ig, "куда переводить?", [], []);
    expect(sent().join("\n")).toMatch(PHONE);
  });
});
