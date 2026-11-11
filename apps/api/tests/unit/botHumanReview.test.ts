import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * Находки ревью ветки fix/bot-human-sales (11.11.2026): каждая проверка падала бы
 * на коде до правки. Данные выдуманные.
 */
vi.mock("../../src/instagram.js", () => ({
  sendText: vi.fn(async () => "mid-out"),
  sendAttachment: vi.fn(async () => "mid-att"),
  channelOf: (c: { channel?: string }) => c.channel ?? "INSTAGRAM",
}));
vi.mock("../../src/whatsapp/transport.js", () => ({
  sendWhatsAppText: vi.fn(async () => "wa:out-1"),
  sendWhatsAppAttachment: vi.fn(async () => "wa:att-1"),
}));

import { explicitOfflineInterest } from "../../src/ai/offlineHandoff.js";
import { stripServiceMarkers, humanizeBotText } from "../../src/ai/humanText.js";
import { cleanAutomatedReply, REPLY_POLICY_INSTRUCTION } from "../../src/ai/replyPolicy.js";
import { withoutRepeats, accessCovers, regenerateAfterFilters, type RepeatContext } from "../../src/ai/repeatGuard.js";
import { sendAttachmentToContact, mediaAlreadySent, SENT_MEDIA_PREFIX } from "../../src/messaging/send.js";
import { sendWhatsAppAttachment } from "../../src/whatsapp/transport.js";
import { DEFAULT_OFFLINE_FACTS, DEFAULT_OFFLINE_ADDRESS_TG } from "../../src/ai/offlineFacts.js";
import { ALWAYS_RULES } from "../../src/ai/prompts.js";
import { guardReply } from "../../src/ai/offTopicGuard.js";
import { processWebhookInbox, MAX_PARALLEL_HANDLERS, type InboxEvent } from "../../src/webhookInbox.js";
import * as database from "../../src/db.js";

let db: PrismaMock;
beforeEach(() => {
  vi.clearAllMocks();
  db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("setting").findUnique.mockResolvedValue(null);
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("п.2 ложный офлайн", () => {
  it.each(["адрес сайта какой?", "сайтатон адресш чи?", "Як савол назди шумо дорам", "ба назди ман фиристед", "Скиньте адрес страницы в инстаграме"])(
    "«%s» — не офлайн",
    (q) => expect(explicitOfflineInterest(q)).toBe(false),
  );
  it.each([
    "Офлайн курс кай?",
    "очно можно?",
    "Дар назди шумо омада ёд гирам мешавад?",
    "назди шумо омадан мумкин?",
    "Адрес курса какой?",
    "Где проходит курс?",
    "Сурогаатон куҷо?",
    "700 сомони курс",
  ])("«%s» — офлайн", (q) => expect(explicitOfflineInterest(q)).toBe(true));
});

describe("п.3 служебные метки клиенту не уходят", () => {
  it("любая [МЕТКА] в скобках режется, обычные скобки и «[1]» — нет", () => {
    expect(stripServiceMarkers("Сейчас уточню [ASK_SHIRIN]")).toBe("Сейчас уточню");
    expect(stripServiceMarkers("[NO_REPLY]")).toBe("");
    expect(stripServiceMarkers("Курс [OFFLINE CARD] 70 сомони")).toBe("Курс 70 сомони");
    expect(stripServiceMarkers("[ask_shirin] хорошо")).toBe("хорошо");
    expect(stripServiceMarkers("Шаг [1] из меню (если удобно)")).toBe("Шаг [1] из меню (если удобно)");
  });
  it("обе двери бота режут метки: cleanAutomatedReply и humanizeBotText", () => {
    expect(cleanAutomatedReply("Хуб [ASK_SHIRIN]")).toBe("Хуб");
    expect(humanizeBotText("Хуб [МЕТКА]", { keepTajikLetters: false })).toBe("Хуб");
  });
});

describe("п.4 реквизиты оплатившему и чек — по курсу", () => {
  const base: RepeatContext = {
    phone: "905355355",
    requisitesSentRecently: false,
    receiptAskedRecently: false,
    paidWithAccess: false,
    hasAcceptedReceipt: false,
    clientAsksToPay: false,
  };
  it("оплатившему реквизиты НЕ режем (номер нужен для второго курса), просьбу чека — режем", () => {
    const r = withoutRepeats("905 355 355 Фарангис Чаборова\nЧекро фиристед", { ...base, paidWithAccess: true }, "tg");
    expect(r.text).toContain("905 355 355");
    expect(r.text).not.toMatch(/Чекро/);
  });
  it("купил «21 рецепт», пишет про арт-десерты — доступ НЕ покрывает (чек нужен)", () => {
    expect(accessCovers(["COURSE70"], "Арт десерт ҳам мехоҳам")).toBe(false);
    expect(accessCovers(["COURSE70"], "Ссылка не открывается")).toBe(true);
    expect(accessCovers(["COURSE70"], "Куда перевести?")).toBe(false);
    expect(accessCovers(["COURSE70", "COURSE50"], "Куда перевести?")).toBe(true);
    expect(accessCovers([], "Чек фиристодам")).toBe(false);
  });
  it("после фильтра пусто — повторный ход; снова пусто или ошибка — null (зовём человека), [NO_REPLY] — законное молчание", async () => {
    const ctx = { ...base, receiptAskedRecently: true };
    expect(await regenerateAfterFilters(["receipt_ask"], async () => "Курс 70 сомони, навсегда", ctx, "ru")).toBe("Курс 70 сомони, навсегда");
    expect(await regenerateAfterFilters(["receipt_ask"], async () => "Пришлите чек, пожалуйста", ctx, "ru")).toBeNull();
    expect(await regenerateAfterFilters(["receipt_ask"], async () => null, ctx, "ru")).toBeNull();
    expect(await regenerateAfterFilters(["receipt_ask"], async () => "[NO_REPLY]", ctx, "ru")).toBe("");
    const hint = vi.fn(async (_extra: string) => "ок");
    await regenerateAfterFilters(["requisites"], hint, ctx, "ru");
    expect(hint.mock.calls[0][0]).toMatch(/номер для оплаты уже есть/);
  });
});

describe("п.7 WhatsApp: отправленное вложение помнится", () => {
  it("фото меню в WhatsApp — строка в истории и метка, mediaAlreadySent его видит", async () => {
    const wa = { id: "contact-1", igUserId: "992000000001@c.us", channel: "WHATSAPP" };
    db.model("contact").findUnique.mockResolvedValue(fakeContact({ channel: "WHATSAPP" }));
    await sendAttachmentToContact(wa, "https://example.test/menu.jpg", "image");
    expect(sendWhatsAppAttachment).toHaveBeenCalledWith(wa, "https://example.test/menu.jpg", "image");
    expect(db.model("message").create).toHaveBeenCalledWith({ data: { contactId: "contact-1", direction: "OUT", text: "", mid: "wa:att-1" } });
    expect(db.model("message").updateMany).toHaveBeenCalledWith({
      where: { mid: "wa:att-1", direction: "OUT" },
      data: { payload: `${SENT_MEDIA_PREFIX}https://example.test/menu.jpg` },
    });
    db.model("message").findFirst.mockResolvedValue({ id: "m1" });
    expect(await mediaAlreadySent("contact-1", "https://example.test/menu.jpg")).toBe(true);
  });
});

describe("п.9 промпт и адрес", () => {
  it("смайлики: «добавляет система, сам не ставь», а не «без смайликов»", () => {
    expect(ALWAYS_RULES).toMatch(/СМАЙЛИКИ ДОБАВЛЯЕТ СИСТЕМА, САМ НЕ СТАВЬ/);
    expect(ALWAYS_RULES).not.toMatch(/БЕЗ СМАЙЛИКОВ/);
    expect(REPLY_POLICY_INSTRUCTION).toMatch(/их добавляет система/);
    expect(REPLY_POLICY_INSTRUCTION).not.toMatch(/Без эмодзи/);
    const script = fs.readFileSync(path.resolve(__dirname, "../../../../ops/2026-11-11-bot-texts.mjs"), "utf8");
    expect(script).toContain("Смайлики сам не ставь: когда уместно, их добавляет система.");
  });
  it("запасной адрес — «Рудаки 177, назди Воданасос» на обоих языках", () => {
    expect(DEFAULT_OFFLINE_FACTS.address).toBe("Душанбе, Рудаки 177, назди Воданасос");
    expect(DEFAULT_OFFLINE_ADDRESS_TG).toBe(DEFAULT_OFFLINE_FACTS.address);
  });
});

describe("п.10 бот не пишет о Ширин в третьем лице", () => {
  it("«позвать человека» — от первого лица", () => {
    for (const lang of ["ru", "tg", "en"] as const) {
      expect(guardReply("wants_human", lang)).not.toMatch(/Ширин|Shirin/);
    }
    expect(ALWAYS_RULES).not.toMatch(/Ширин сама ответит|Передаю Ширин/);
  });
});

describe("п.11 потолок параллельности очереди вебхуков", () => {
  it(`одновременно в работе не больше ${MAX_PARALLEL_HANDLERS}, остальные берутся по мере освобождения, ни одно не теряется`, async () => {
    const ev = (mid: string): InboxEvent => ({ channel: "INSTAGRAM", selfId: "page", kind: "message", event: { sender: { id: mid }, message: { mid, text: mid } } });
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, payload: JSON.stringify(ev(`m${i}`)), attempts: 0 }));
    const claimed = new Set<string>();
    db.model("webhookInbox").findMany.mockImplementation(async (args: unknown) => {
      const take = (args as { take: number }).take;
      return rows.filter((r) => !claimed.has(r.id)).slice(0, take);
    });
    db.model("webhookInbox").updateMany.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: string } }).where.id;
      if (claimed.has(id)) return { count: 0 };
      claimed.add(id);
      return { count: 1 };
    });
    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    const releases: (() => void)[] = [];
    const handle = async (e: InboxEvent) => {
      running++;
      peak = Math.max(peak, running);
      seen.push((e.event.message as { mid: string }).mid);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
    };
    const first = processWebhookInbox(handle);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(MAX_PARALLEL_HANDLERS);
    // Второй вебхук, пока места заняты, — ничего не запускает сверх потолка.
    await processWebhookInbox(handle);
    expect(running).toBeLessThanOrEqual(MAX_PARALLEL_HANDLERS);
    // Освобождаем места по одному — очередь добирается сама.
    for (let i = 0; i < 20 && seen.length < rows.length + 0; i++) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
    while (releases.length) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await first;
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_HANDLERS);
    expect(new Set(seen).size).toBe(rows.length);
  });
});
