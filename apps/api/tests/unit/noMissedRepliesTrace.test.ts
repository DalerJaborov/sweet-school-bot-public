import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * СЛЕД КАЖДОГО «НЕ ОТВЕЧАЕМ» (аудит 15.11.2026): за 7 дней 84 человека остались
 * без ответа, а журнал решений знал про 41 случай. Ход aiReply, после которого
 * клиенту ничего не ушло, теперь всегда пишет причину (messaging/noReply.ts) —
 * и сторож отличает решение («молчать») от ожидания («ждём человека») и от потери.
 * Данные выдуманные.
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
const SETTINGS: Record<string, string> = { aiEnabled: "true" };
let outSince = false;

function said(text: string) {
  return { text, model: "gemini-3.7-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

beforeEach(() => {
  db = mockPrisma();
  outSince = false;
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("message").findMany.mockResolvedValue([]);
  db.model("message").count.mockResolvedValue(5);
  db.model("purchase").count.mockResolvedValue(0);
  // «Ушло ли что-то клиенту за этот ход» — единственный вопрос следа к истории.
  db.model("message").findFirst.mockImplementation(
    async (args: { where?: { direction?: string; createdAt?: unknown } }) =>
      args?.where?.direction === "OUT" && args.where.createdAt && outSince ? { id: "out-1" } : null,
  );
  generateWithFallback.mockReset();
  sendToContact.mockReset().mockImplementation(async () => {
    outSince = true;
    return "mid-1";
  });
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

const ig = fakeContact({ channel: "INSTAGRAM", humanTakenOverAt: null, humanSilencedUntil: null }) as Parameters<
  typeof aiReply
>[0];
const gateRow = () =>
  db.model("replyGate").create.mock.calls.map((c) => (c[0] as { data: Record<string, string> }).data);

describe("aiReply: молчание всегда с причиной", () => {
  it("модель сказала [NO_REPLY] — в журнале «молчим нарочно» с началом сообщения", async () => {
    generateWithFallback.mockResolvedValue(said("[NO_REPLY]"));
    await aiReply(ig, "Хоп, фаҳмидам", [], []);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(gateRow()).toEqual([
      expect.objectContaining({
        contactId: "contact-1",
        cls: "policy",
        action: "silent",
        reason: expect.stringMatching(/^model_no_reply/),
        preview: "Хоп, фаҳмидам",
      }),
    ]);
  });

  it("Ширин ведёт разговор (пауза 3 ч) — модель не зовём, в журнале «ждём человека», сторож ответит после", async () => {
    await aiReply({ ...ig, humanTakenOverAt: new Date() } as typeof ig, "Нарх чанд?", [], []);
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(gateRow()).toEqual([
      expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^human_takeover/) }),
    ]);
  });

  it("бот сказал «уточню» и ждёт Ширин час — тоже «ждём человека», а не тишина без следа", async () => {
    await aiReply({ ...ig, humanSilencedUntil: new Date(Date.now() + 30 * 60_000) } as typeof ig, "А когда?", [], []);
    expect(gateRow()).toEqual([
      expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^human_requested/) }),
    ]);
  });

  it("ответ ушёл — журнал не трогаем", async () => {
    generateWithFallback.mockResolvedValue(said("Курс 70 сомони, навсегда."));
    await aiReply(ig, "Нарх чанд?", [], []);
    expect(sendToContact).toHaveBeenCalled();
    expect(db.model("replyGate").create).not.toHaveBeenCalled();
  });

  it("отправка упала — причина «сбой отправки» записана, ошибка уходит дальше (очередь вебхуков повторит)", async () => {
    generateWithFallback.mockResolvedValue(said("Курс 70 сомони, навсегда."));
    sendToContact.mockReset().mockRejectedValue(new Error("Meta 500"));
    await expect(aiReply(ig, "Нарх чанд?", [], [])).rejects.toThrow("Meta 500");
    expect(gateRow()).toEqual([
      expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^send_failed/) }),
    ]);
  });

  it("ИИ не ответил — ход в очереди повторов и «ждём» в журнале", async () => {
    generateWithFallback.mockResolvedValue({ error: new Error("503") });
    await aiReply(ig, "Нарх чанд?", [], []);
    expect(gateRow()).toEqual([
      expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^ai_error/) }),
    ]);
  });
});

describe("ревью PR #96: след и поведение хода", () => {
  it("п.7 экстренная пауза — «ждём», а не окончательное молчание: после снятия паузы сторож ответит", async () => {
    SETTINGS.botFrozen = "true";
    try {
      await aiReply(ig, "Нарх чанд?", [], []);
    } finally {
      delete SETTINGS.botFrozen;
    }
    expect(gateRow()).toEqual([expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^frozen/) })]);
  });

  it("п.10 WhatsApp повторяет ход сам — упавшая попытка строку в журнал не пишет", async () => {
    generateWithFallback.mockResolvedValue(said("Курс 70 сомони, навсегда."));
    sendToContact.mockReset().mockRejectedValue(new Error("bridge busy"));
    const wa = { ...ig, channel: "WHATSAPP" } as typeof ig;
    await expect(aiReply(wa, "Нарх чанд?", [], [])).rejects.toThrow();
    expect(db.model("replyGate").create).not.toHaveBeenCalled();
  });

  it("п.4 «уточню» уже обещано и Ширин не ответила — второго «уточню» клиенту нет, ждём её", async () => {
    db.model("contact").findUnique.mockResolvedValue({ humanRequestedAt: new Date(Date.now() - 90 * 60_000) });
    generateWithFallback.mockResolvedValue(said("[ASK_SHIRIN]"));
    await aiReply(ig, "А скидка есть?", [], []);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(gateRow()).toEqual([expect.objectContaining({ action: "wait", reason: expect.stringMatching(/^human_requested/) })]);
  });

  it("п.4 первое «уточню» уходит как раньше", async () => {
    db.model("contact").findUnique.mockResolvedValue({ humanRequestedAt: null });
    generateWithFallback.mockResolvedValue(said("[ASK_SHIRIN]"));
    await aiReply(ig, "А скидка есть?", [], []);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/уточню/i);
  });

  it("п.5 сторож отвечает спустя больше двух часов — в промпте просьба коротко извиниться на «вы»", async () => {
    generateWithFallback.mockResolvedValue(said("Курс 70 сомони, навсегда."));
    await aiReply(ig, "Нарх чанд?", [], [], { waitedMs: 3 * 3_600_000 });
    const build = generateWithFallback.mock.calls[0][2] as (m: string) => string;
    expect(JSON.parse(build("m")).system_instruction.parts[0].text).toContain("извинения за задержку");
  });

  it("п.5 обычный ход — без извинений", async () => {
    generateWithFallback.mockResolvedValue(said("Курс 70 сомони, навсегда."));
    await aiReply(ig, "Нарх чанд?", [], []);
    const build = generateWithFallback.mock.calls[0][2] as (m: string) => string;
    expect(JSON.parse(build("m")).system_instruction.parts[0].text).not.toContain("извинения за задержку");
  });
});

describe("сторож в CI: исходящие в Instagram/Messenger — только через дверь отправки", () => {
  it("sendText / sendAttachment / sendPrivateReply из instagram.ts импортирует только messaging/send.ts (и тестовая кнопка админки)", () => {
    const root = path.resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const rel = path.relative(root, full).replace(/\\/g, "/");
          if (rel === "instagram.ts" || rel === "messaging/send.ts" || rel === "admin.ts") continue;
          const text = fs.readFileSync(full, "utf8");
          for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[./]*instagram\.js"/g)) {
            if (/\b(sendText|sendAttachment|sendPrivateReply)\b/.test(m[1])) offenders.push(rel);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
