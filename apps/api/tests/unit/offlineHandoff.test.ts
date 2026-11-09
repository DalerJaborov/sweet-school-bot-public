import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * «ОФЛАЙН: ПЕРЕДАНО ШИРИН» (владелец 08.11.2026): клиент написал про офлайн —
 * бот отправляет карточку с условиями, и всё; дальше консультирует Ширин. Пишет
 * «онлайн» — бот сразу подключается обратно. Рубильник offlineHandoffEnabled.
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
vi.mock("../../src/ai/voiceReply.js", () => ({ trySendVoiceReply: vi.fn(async () => null) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ buildStyleBlock: vi.fn(async () => "") }));
vi.mock("../../src/nightlyLearning.js", () => ({ buildInsightsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/objectionLibrary.js", () => ({ buildObjectionsBlock: vi.fn(async () => "") }));
vi.mock("../../src/ai/mediaReuse.js", () => ({ findReusableMedia: vi.fn(async () => null), sendReusedMedia: vi.fn() }));
vi.mock("../../src/ai/menuImages.js", () => ({ sendMenuImages: vi.fn() }));
vi.mock("../../src/ai/testimonials.js", async (original) => ({
  ...(await original<typeof import("../../src/ai/testimonials.js")>()),
  maybeSendTestimonial: vi.fn(async () => undefined),
}));
vi.mock("../../src/learningCheckIn.js", () => ({ markStartedLearningIfReplied: vi.fn(async () => undefined) }));
vi.mock("../../src/stuckAlert.js", () => ({ notifyIfStuck: vi.fn(async () => undefined) }));
vi.mock("../../src/course/recovery.js", () => ({ maybeRestoreAccess: vi.fn(async () => ({ handled: false })) }));
vi.mock("../../src/ai/offlineSignup.js", () => ({ registerOfflineSignup: vi.fn(async () => false) }));
const maybeSendOfflineCard = vi.fn(async () => false);
vi.mock("../../src/ai/offlineCourse.js", async (original) => ({
  ...(await original<typeof import("../../src/ai/offlineCourse.js")>()),
  maybeSendOfflineCard: (...a: unknown[]) => maybeSendOfflineCard(...a),
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
import { isOnlineRequest, offlineHandoffGate, isCancelOrDoubt } from "../../src/ai/offlineHandoff.js";

let db: PrismaMock;
let SETTINGS: Record<string, string>;

function said(text: string) {
  return { text, model: "gemini-3.7-flash", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
}

/** Что записали в контакт последним update'ом. */
function lastContactUpdate(): { offlineHandoffAt?: Date | null } | undefined {
  const calls = db.model("contact").update.mock.calls;
  return (calls[calls.length - 1]?.[0] as { data: { offlineHandoffAt?: Date | null } } | undefined)?.data;
}

beforeEach(() => {
  db = mockPrisma();
  SETTINGS = { aiEnabled: "true" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("message").findMany.mockResolvedValue([]);
  db.model("message").count.mockResolvedValue(5);
  db.model("purchase").count.mockResolvedValue(0);
  generateWithFallback.mockReset();
  sendToContact.mockClear();
  maybeSendOfflineCard.mockReset();
  maybeSendOfflineCard.mockResolvedValue(false);
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

type C = Parameters<typeof aiReply>[0];
const lead = fakeContact({ offlineHandoffAt: null }) as C;
const handedOff = fakeContact({ offlineHandoffAt: new Date("2026-11-08T10:00:00Z") }) as C;

describe("isOnlineRequest — слово «онлайн» на трёх раскладках", () => {
  it.each([
    "хочу онлайн",
    "А онлайн курс есть?",
    "курси онлайни чанд пул?",
    "онлайнӣ мехоҳам",
    "online kurs hast?",
    "onlayn mexoham",
    "можно дистанционно?",
    "таълими масофавӣ доред?",
    "а через интернет можно?",
    "Нет, мне онлайн надо, Dushanbe далеко",
  ])("да: «%s»", (text) => {
    expect(isOnlineRequest(text)).toBe(true);
  });

  it.each(["хочу офлайн", "запишите меня на курс", "сайт shirinsweets.online", "Салом", ""])("нет: «%s»", (text) => {
    expect(isOnlineRequest(text)).toBe(false);
  });
});

describe("offlineHandoffGate", () => {
  it("отметки нет — обычный путь", async () => {
    expect(await offlineHandoffGate(lead, "сколько стоит?")).toBe("none");
  });

  it("отметка есть, про онлайн ни слова — молчим", async () => {
    expect(await offlineHandoffGate(handedOff, "а когда начало?")).toBe("silent");
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("написала «онлайн» — отметка снимается, бот подключается", async () => {
    expect(await offlineHandoffGate(handedOff, "нет, мне онлайн")).toBe("resume");
    expect(lastContactUpdate()).toEqual({ offlineHandoffAt: null });
  });

  it("купила онлайн-курс — состояние снимается само", async () => {
    expect(await offlineHandoffGate({ ...handedOff, paid: true } as C, "спасибо")).toBe("resume");
    expect(lastContactUpdate()).toEqual({ offlineHandoffAt: null });
  });

  it("рубильник выключен — состояние не действует", async () => {
    SETTINGS.offlineHandoffEnabled = "false";
    expect(await offlineHandoffGate(handedOff, "а когда начало?")).toBe("none");
  });
});

describe("aiReply: офлайн → одна карточка и тишина; «онлайн» → бот снова отвечает", () => {
  it("ГЛАВНОЕ: клиент спросил про офлайн — ушла карточка, модель не звали, поставлена отметка", async () => {
    maybeSendOfflineCard.mockResolvedValueOnce(true);

    await aiReply(lead, "Салом, офлайн курс доред?", [], []);

    expect(maybeSendOfflineCard).toHaveBeenCalledTimes(1);
    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled(); // карточку шлёт сам offlineCourse.ts, модель — ничего
    expect(lastContactUpdate()?.offlineHandoffAt).toBeInstanceOf(Date);
  });

  it("после карточки пишет ещё («а адрес?», номер телефона) — ни текста, ни хода модели", async () => {
    await aiReply(handedOff, "А адрес какой? +992 900 00 00 00", [], []);
    await aiReply(handedOff, "Суроғааш куҷо?", [], []);

    expect(generateWithFallback).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(maybeSendOfflineCard).not.toHaveBeenCalled();
  });

  it("написала «онлайн» (рус.) — бот сразу подключается и отвечает", async () => {
    generateWithFallback.mockResolvedValue(said("Онлайн-курс стоит 70 сомони."));

    await aiReply(handedOff, "Передумала, хочу онлайн", [], []);

    expect(lastContactUpdate()).toEqual({ offlineHandoffAt: null });
    expect(generateWithFallback).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toBe("Онлайн-курс стоит 70 сомони.");
  });

  it("смешанные языки: «online mexoham, нархаш чанд?» — тоже выход", async () => {
    generateWithFallback.mockResolvedValue(said("Нархи курси онлайн 70 сомонӣ, апаҷон."));

    await aiReply(handedOff, "online mexoham, нархаш чанд?", [], []);

    expect(lastContactUpdate()).toEqual({ offlineHandoffAt: null });
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });

  it("«запишите меня на онлайн курс» — это не офлайн: карточку не шлём, отвечает модель", async () => {
    generateWithFallback.mockResolvedValue(said("Конечно, вот как оплатить."));

    await aiReply(lead, "запишите меня на онлайн курс", [], []);

    expect(maybeSendOfflineCard).not.toHaveBeenCalled();
    expect(generateWithFallback).toHaveBeenCalledTimes(1);
  });

  it("рубильник выключен — прежний порядок: карточка и ход модели в том же сообщении", async () => {
    SETTINGS.offlineHandoffEnabled = "false";
    maybeSendOfflineCard.mockResolvedValueOnce(true);
    generateWithFallback.mockResolvedValue(said("Напишите, пожалуйста, имя и номер."));

    await aiReply(lead, "хочу офлайн", [], []);

    expect(maybeSendOfflineCard).toHaveBeenCalledTimes(1);
    expect(generateWithFallback).toHaveBeenCalledTimes(1);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("карточку уже слали в этом наборе (старый контакт) — в состояние не входим, прежний порядок", async () => {
    maybeSendOfflineCard.mockResolvedValue(false);
    generateWithFallback.mockResolvedValue(said("Напишите имя и номер телефона."));

    await aiReply(fakeContact({ offlineInfoSentAt: new Date(), offlineHandoffAt: null }) as C, "офлайн когда?", [], []);

    expect(generateWithFallback).toHaveBeenCalledTimes(1);
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });
});

/**
 * Владелец 09.11.2026: после карточки офлайна бот молчал на ВСЁ — и в чате
 * сайта, где Ширин нет вовсе, и на отмену записи. Теперь не молчит.
 */
describe("офлайн передан Ширин — где молчать нельзя", () => {
  it("ГЛАВНОЕ: чат на сайте — бот отвечает (Ширин там нет), отметка остаётся", async () => {
    const web = fakeContact({ channel: "WEB", offlineHandoffAt: new Date() }) as C;
    expect(await offlineHandoffGate(web, "а адрес какой?")).toBe("none");
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("отмена или сомнение по записи — бот отвечает, отметка остаётся", async () => {
    expect(await offlineHandoffGate(handedOff, "Я передумала, не смогу прийти")).toBe("none");
    expect(await offlineHandoffGate(handedOff, "Боюсь, не получится у меня")).toBe("none");
    expect(await offlineHandoffGate(handedOff, "Бекор кунед, наметавонам")).toBe("none");
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("обычный вопрос в Instagram — по-прежнему молчим (ведёт Ширин, сторож напомнит ей)", async () => {
    expect(await offlineHandoffGate(handedOff, "а адрес какой?")).toBe("silent");
  });

  it("признак отмены не цепляет обычные вопросы", () => {
    expect(isCancelOrDoubt("Когда начало курса?")).toBe(false);
    expect(isCancelOrDoubt("Адрес куҷост?")).toBe(false);
    expect(isCancelOrDoubt("Я отменяю запись")).toBe(true);
  });
});

