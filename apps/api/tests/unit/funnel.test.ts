import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, fakeFunnel, fakeStep, type PrismaMock } from "../helpers.js";

// Внешний мир воронки: Meta и ИИ. Отправки — моки, чтобы тест не ходил в сеть
// и чтобы можно было проверить, ЧТО именно ушло клиенту.
vi.mock("../../src/instagram.js", () => ({
  sendText: vi.fn(async () => "mid-1"),
  sendPrivateReply: vi.fn(async () => "mid-2"),
  sendAttachment: vi.fn(async () => null),
  replyToComment: vi.fn(async () => undefined),
  deleteComment: vi.fn(async () => undefined),
  channelOf: () => "INSTAGRAM",
  mediaPermalink: vi.fn(async () => null),
}));
vi.mock("../../src/ai.js", () => ({ aiReplyToComment: vi.fn(async () => undefined) }));
vi.mock("../../src/ownMedia.js", () => ({ instagramShortcode: () => null }));

import { sendText } from "../../src/instagram.js";
import {
  parseKeywords,
  parseMediaIds,
  parseTags,
  parseStepButtons,
  matchesKeywords,
  handleIncomingDm,
} from "../../src/funnel.js";
import type { Contact } from "@prisma/client";

describe("разбор JSON-колонок воронки", () => {
  it("битый JSON даёт пустой список, а не исключение", () => {
    expect(parseKeywords({ keywords: "{oops" })).toEqual([]);
    expect(parseMediaIds({ mediaIds: "null" })).toEqual([]);
    expect(parseTags({ tags: "" })).toEqual([]);
    expect(parseStepButtons({ funnelId: "f", buttons: "[1, 2]" })).toEqual([]);
  });

  it("отбрасывает мусор внутри массива, оставляя годные элементы", () => {
    expect(parseKeywords({ keywords: JSON.stringify(["цена", "", 42, "  ", "курс"]) })).toEqual(["цена", "курс"]);
    expect(
      parseStepButtons({
        funnelId: "f1",
        buttons: JSON.stringify([{ title: "Да", targetOrder: 2 }, { title: "", targetOrder: 3 }, { title: "Нет" }]),
      })
    ).toEqual([{ title: "Да", payload: "step:f1:2" }]);
  });
});

describe("matchesKeywords", () => {
  it("пустой список — подходит любое сообщение", () => {
    expect(matchesKeywords([], "что угодно")).toBe(true);
  });
  it("совпадение без учёта регистра и как подстрока", () => {
    expect(matchesKeywords(["Цена"], "а какая ЦЕНА курса?")).toBe(true);
    expect(matchesKeywords(["цена"], "здравствуйте")).toBe(false);
  });
});

describe("handleIncomingDm", () => {
  let db: PrismaMock;
  const contact = fakeContact() as unknown as Contact;

  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("сообщение без ключевого слова воронку не запускает", async () => {
    db.model("funnel").findMany.mockResolvedValue([fakeFunnel({ keywords: JSON.stringify(["цена"]) })]);

    const handled = await handleIncomingDm(contact, "здравствуйте", null);

    expect(handled).toBe(false);
    expect(db.model("delivery").create).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("совпавшее слово запускает воронку: доставка создаётся, первый шаг уходит", async () => {
    const funnel = fakeFunnel({ keywords: JSON.stringify(["цена"]) });
    const step = fakeStep();
    db.model("funnel").findMany.mockResolvedValue([funnel]);
    // Первый findFirst — первый шаг; второй (после отправки) — «следующего нет».
    db.model("funnelStep").findFirst.mockResolvedValueOnce(step).mockResolvedValueOnce(null);
    db.model("delivery").findUnique.mockResolvedValue(null);
    db.model("delivery").create.mockImplementation(async () => ({
      id: "delivery-1",
      funnelId: funnel.id,
      contactId: contact.id,
      contact,
    }));

    const handled = await handleIncomingDm(contact, "Какая цена?", null);

    expect(handled).toBe(true);
    expect(db.model("delivery").create).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(contact.igUserId, "Привет!", [], "INSTAGRAM");
    // Метка старта воронки дописывается контакту.
    expect(db.model("contact").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tags: JSON.stringify(["kurs_started"]) } })
    );
    // Шагов больше нет — доставка закрыта.
    expect(db.model("delivery").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { state: "DONE", nextRunAt: null } })
    );
  });

  it("повтор раньше окна repeatAfterDays — молчим", async () => {
    const funnel = fakeFunnel({ repeatAfterDays: 30 });
    db.model("funnel").findMany.mockResolvedValue([funnel]);
    db.model("funnelStep").findFirst.mockResolvedValue(fakeStep());
    db.model("delivery").findUnique.mockResolvedValue({ id: "d", createdAt: new Date() });

    const handled = await handleIncomingDm(contact, "привет", null);

    expect(handled).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(db.model("delivery").update).not.toHaveBeenCalled();
  });
});
