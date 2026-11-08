import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Ревью 08.11.2026 (PR 37): шлюз «не по делу» не должен молчать покупательнице,
 * нарезка не должна рвать цены, адреса и списки, тёплый смайлик должен доходить.
 */

// ---------- моки зависимостей шлюза ----------
const { settings, gate, message, purchase, inbox, sendToContact, generate, voiceToText, turnRef } = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  gate: { count: vi.fn(), create: vi.fn(async () => ({})) },
  message: { count: vi.fn(), findMany: vi.fn(async () => []) },
  purchase: { count: vi.fn(async () => 0) },
  inbox: { update: vi.fn(async () => ({})) },
  sendToContact: vi.fn(async () => "mid-1"),
  generate: vi.fn(),
  voiceToText: vi.fn(),
  turnRef: { current: undefined as { inboxId: string } | undefined },
}));
vi.mock("../../src/db.js", () => ({
  prisma: { replyGate: gate, message, purchase, whatsAppInbox: inbox },
  getSetting: vi.fn(async (k: string) => settings[k] ?? null),
  logError: vi.fn(),
  logWarn: vi.fn(),
  recordOutgoingMessage: vi.fn(async () => undefined),
}));
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
vi.mock("../../src/whatsapp/context.js", () => ({ currentWhatsAppTurn: () => turnRef.current }));
vi.mock("../../src/gemini.js", () => ({
  generateWithFallback: (...a: unknown[]) => generate(...a),
  thinkingConfigFor: () => undefined,
}));
vi.mock("../../src/ai/geminiKeys.js", () => ({ resolveGeminiKeys: vi.fn(async () => ["key"]) }));
vi.mock("../../src/ai/aiLog.js", () => ({ logAiCall: vi.fn(async () => undefined) }));
vi.mock("../../src/ai/voiceToText.js", () => ({ voiceToText: (...a: unknown[]) => voiceToText(...a) }));

import { passesRelevanceGate } from "../../src/ai/relevanceGate.js";
import { splitHumanLike } from "../../src/ai/replySplit.js";
import { cleanKeepingWarmTail, cleanAutomatedReply } from "../../src/ai/replyPolicy.js";
import { codeRelevance } from "../../src/ai/relevance.js";

const contact = (extra: Record<string, unknown> = {}) =>
  ({ id: "c1", channel: "INSTAGRAM", paid: false, accessRevokedAt: null, ...extra }) as never;

function modelSays(cls: string) {
  generate.mockResolvedValue({ text: JSON.stringify({ cls, reason: "тест" }), model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  turnRef.current = undefined;
  gate.count.mockResolvedValue(0);
  message.count.mockResolvedValue(0);
  purchase.count.mockResolvedValue(0);
  message.findMany.mockResolvedValue([]);
});

describe("passesRelevanceGate", () => {
  it("рубильник выключен — шлюз ничего не делает", async () => {
    settings.replyGateEnabled = "false";
    expect(await passesRelevanceGate(contact(), "Я курьер", [], false, "ru")).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });
  it("чат на сайте и фото-чек проходят без разбора", async () => {
    expect(await passesRelevanceGate(contact({ channel: "WEB" }), "Как дела?", [], false, "ru")).toBe(true);
    expect(await passesRelevanceGate(contact(), "", [{ url: "u", kind: "image" }], true, "ru")).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });
  it("старый собеседник (оплатил) и разговор, который уже идёт, проходят", async () => {
    expect(await passesRelevanceGate(contact({ paid: true }), "Ок", [], false, "ru")).toBe(true);
    message.count.mockResolvedValue(2); // мы уже отвечали
    gate.count.mockResolvedValue(0);
    expect(await passesRelevanceGate(contact(), "Я курьер", [], false, "ru")).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });
  it("курьер от нового человека — молчим и пишем причину в журнал", async () => {
    modelSays("delivery");
    expect(await passesRelevanceGate(contact(), "Выйдите, я у ворот с пакетом", [], false, "ru")).toBe(false);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(gate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cls: "delivery", action: "silent" }) }));
  });
  it("просьба позвонить проходит, «?» получает один уточняющий вопрос", async () => {
    expect(await passesRelevanceGate(contact(), "Позвоните мне пожалуйста", [], false, "ru")).toBe(true);
    expect(await passesRelevanceGate(contact(), "?", [], false, "ru")).toBe(false);
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String((sendToContact.mock.calls as unknown[][])[0][1])).toMatch(/Здравствуйте/);
  });
  it("непонятное второй раз: WhatsApp — «нужен человек», Instagram — обычный ответ", async () => {
    modelSays("unclear");
    gate.count.mockImplementation(async (arg: { where: { action?: string; cls?: string } }) => (arg.where.action === "clarify" ? 1 : 0));
    message.count.mockResolvedValue(1); // наш единственный ответ — это и был вопрос шлюза
    turnRef.current = { inboxId: "inbox-1" };
    expect(await passesRelevanceGate(contact({ channel: "WHATSAPP" }), "Скажите", [], false, "ru")).toBe(false);
    expect(inbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "attention", attentionReason: "unclear_message" }) }));
    expect(await passesRelevanceGate(contact(), "Скажите", [], false, "ru")).toBe(true);
  });
  it("модель недоступна: WhatsApp — повтор, Instagram — отвечаем как раньше", async () => {
    generate.mockResolvedValue({ error: "down" });
    await expect(passesRelevanceGate(contact({ channel: "WHATSAPP" }), "Подскажите про торт на юбилей", [], false, "ru")).rejects.toThrow(/WhatsAppGenerationRetry/);
    expect(await passesRelevanceGate(contact(), "Подскажите про торт на юбилей", [], false, "ru")).toBe(true);
  });
  it("голосовое: не расшифровалось — WhatsApp «нужен человек», Instagram идёт дальше", async () => {
    voiceToText.mockResolvedValue(null);
    turnRef.current = { inboxId: "inbox-2" };
    expect(await passesRelevanceGate(contact({ channel: "WHATSAPP" }), "", [{ url: "a", kind: "audio" }], false, "tg")).toBe(false);
    expect(inbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attentionReason: "voice_unreadable" }) }));
    expect(await passesRelevanceGate(contact(), "", [{ url: "a", kind: "audio" }], false, "tg")).toBe(true);
  });
  it("PDF или видео без подписи не вызывают «какая информация вас интересует»", async () => {
    expect(await passesRelevanceGate(contact(), "", [{ url: "f", kind: "file" } as never], false, "ru")).toBe(true);
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

describe("правила кода: одна дверь с offTopicGuard и receiptClaim", () => {
  it.each([
    "Позвоните мне пожалуйста",
    "Перезвоните, хочу записаться",
    "Занг занед ба ман",
    "Скинула на карту",
    "Пул фиристодам",
    "Я отправила деньги",
    "Оплатила, жду ссылку",
  ])("«%s» — по делу", (t) => {
    expect(codeRelevance(t)?.cls).toBe("on_topic");
  });
  it("«?» и «...» — непонятно, а не пусто; смайлик — пусто", () => {
    expect(codeRelevance("?")?.cls).toBe("unclear");
    expect(codeRelevance("??")?.cls).toBe("unclear");
    expect(codeRelevance("...")?.cls).toBe("unclear");
    expect(codeRelevance("🙂")?.cls).toBe("empty");
  });
});

describe("нарезка не портит текст", () => {
  const ON = { enabled: true, maxParts: 4 };
  it("нумерованный список остаётся одним куском", () => {
    const list =
      "В курсе такие темы. Вот они:\n1. Кремы и начинки для тортов, самые разные.\n2. Бисквиты разных видов и пропитки.\n3. Муссовые десерты и глазури для них.\n4. Оформление и подача готовых десертов.";
    const parts = splitHumanLike(list, ON);
    expect(parts.join("\n")).toContain("1. Кремы");
    for (const p of parts) expect(p).not.toMatch(/\s\d\.$/);
  });
  it("«450 с.» и «г. Душанбе» не разрезаются", () => {
    const text =
      "Весь курс сейчас стоит всего 450 с. за комплект целиком вместе с бонусными материалами для вас. Очный курс проходит по адресу г. Душанбе, улица Рудаки 12, рядом со станцией метро, приходите.";
    for (const p of splitHumanLike(text, ON)) {
      expect(p).not.toMatch(/\s(с|г)\.$/);
    }
  });
  it("WhatsApp (две части): подпись и номер оплаты остаются вместе", () => {
    const parts = splitHumanLike("Оплатите курс на номер ниже и пришлите чек сюда.\n905355355 Алиф\nПосле проверки пришлём вам ссылку на уроки.", { enabled: true, maxParts: 2 });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("905355355");
    expect(parts[1]).not.toContain("905355355");
  });
});

describe("тёплый смайлик доходит до клиента", () => {
  it("один тёплый смайлик в конце сохраняется, остальные вырезаются", () => {
    expect(cleanKeepingWarmTail("Ждём вас 🌸")).toBe("Ждём вас 🌸");
    expect(cleanKeepingWarmTail("Ждём 😀 вас")).toBe(cleanAutomatedReply("Ждём 😀 вас"));
    expect(cleanKeepingWarmTail("Ждём вас 👍")).toBe("Ждём вас");
  });
});
