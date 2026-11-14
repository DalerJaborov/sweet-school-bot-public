import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

/**
 * АВТОПРИНЯТИЕ ЧЕКОВ (08.11.2026). Живой случай: @11._.66_ перевела 71.45
 * сомони за курс в 70 на +992905355355 (Душанбе Сити), два скриншота одного
 * перевода. Бот ответил «чек требует проверки: дата не разобрана», просил
 * другой скриншот и звал владельца, хотя перевод завершён и сумма верная.
 * Теперь честные чеки проходят сами; владельцу — только настоящие сомнения.
 */
const sendToContact = vi.fn(async (..._a: unknown[]) => "mid-1");
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
const sendReceiptForReview = vi.fn(async (..._a: unknown[]) => ({ chatId: "owner-1", messageId: 77 }));
vi.mock("../../src/telegram.js", () => ({
  chatsForKind: vi.fn(async () => ["owner-1"]),
  summaryChatIds: vi.fn(async () => ["owner-1"]),
  sendReceiptForReview: (...a: unknown[]) => sendReceiptForReview(...a),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  editCaption: vi.fn(async () => undefined),
}));
const grantCourses = vi.fn(async (..._a: unknown[]) => ["COURSE70"]);
vi.mock("../../src/ai/grantCourses.js", () => ({ grantCourses: (...a: unknown[]) => grantCourses(...a) }));
vi.mock("../../src/ai/styleLearning.js", () => ({ markExamplesAsSuccessful: vi.fn(async () => undefined) }));
vi.mock("../../src/exchangeRates.js", () => ({
  toSomoni: vi.fn(async (amount: number, cur: string) => (cur === "RUB" ? amount * 0.11 : null)),
}));

import { handleReceiptVerdict } from "../../src/ai/receiptVerdict.js";
import { allocate } from "../../src/courses.js";
import { resetPriceCache } from "../../src/services/priceService.js";
import { diffOffer, OFFER_DEFAULTS, parseOffer } from "../../src/services/offerService.js";

let db: PrismaMock;
let settings: Record<string, string>;
const contact = fakeContact({ askedAltScreenshotAt: null, paid: false }) as Parameters<typeof handleReceiptVerdict>[0];

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    kind: "valid" as const,
    confidence: 95,
    amount: 71.45,
    currency: "TJS",
    receiptAt: null as Date | null,
    recipientMatches: true,
    tamperingSuspected: false,
    reason: "Завершённый перевод по нашему номеру телефона +992905355355 в Душанбе Сити, зачислено 71.45 TJS",
    imageHash: "hash-ds",
    imageUrl: "/media/r.jpg",
    ...overrides,
  };
}

function createdData(): { kind: string; linkSent: boolean; ownerDecision: string | null; reason: string } {
  return (db.model("receiptCheck").create.mock.calls[0][0] as { data: never }).data;
}

beforeEach(() => {
  resetPriceCache();
  db = mockPrisma();
  settings = { telegramBotToken: "t" };
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null,
  );
  db.model("blockedReceipt").findUnique.mockResolvedValue(null);
  db.model("receiptCheck").findUnique.mockResolvedValue(null);
  db.model("receiptCheck").findFirst.mockResolvedValue(null);
  db.model("receiptCheck").create.mockResolvedValue({ id: "r1" });
  db.model("receiptCheck").update.mockResolvedValue({ id: "r1" });
  db.model("receiptCheck").updateMany.mockResolvedValue({ count: 1 });
  db.model("purchase").findMany.mockResolvedValue([]);
  db.model("purchase").count.mockResolvedValue(0);
  db.model("message").findFirst.mockResolvedValue({ text: "Вот чек" });
  sendToContact.mockClear();
  sendReceiptForReview.mockClear();
  grantCourses.mockClear();
  sendTelegramMessage.mockClear();
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("допуск по сумме", () => {
  it.each([
    [71.45, "COURSE70"], // живой пример: цена плюс комиссия банка
    [70, "COURSE70"],
    [50, "COURSE50"],
    [72.74, "COURSE70"],
    [73, "COURSE70"],
    [64, "COURSE70"], // банк «съел» 6 сомони — на границе допуска вниз
    [100, "BOTH"],
  ])("%s сомони", async (amount, expected) => {
    const plan = await allocate("c1", amount);
    expect(plan.grant).toEqual(expected === "BOTH" ? ["COURSE50", "COURSE70"] : [expected]);
  });

  it("недоплата за пределом допуска не открывает курс", async () => {
    expect((await allocate("c1", 40)).grant).toEqual([]);
    expect((await allocate("c1", 43)).grant).toEqual([]);
    // 63 — это уже не 70 с комиссией, а честные 50 с запасом: открывается курс за 50
    expect((await allocate("c1", 63)).grant).toEqual(["COURSE50"]);
  });

  it("допуск берётся из настроек «Цены и даты»", async () => {
    settings.receiptToleranceUp = "1";
    settings.receiptToleranceDown = "0";
    resetPriceCache();
    expect((await allocate("c1", 71.45)).grant).toEqual([]);
    expect((await allocate("c1", 71)).grant).toEqual(["COURSE70"]);
    expect((await allocate("c1", 69)).grant).toEqual([]);
  });
});

describe("честный чек проходит сам", () => {
  it.each([
    ["Душанбе Сити, 71.45, дата не разобрана", { amount: 71.45, receiptAt: null }, ["COURSE70"]],
    [
      "Алиф, 72.74, дата не разобрана",
      { amount: 72.74, receiptAt: null, reason: "Алиф Банк, +992 905 355355" },
      ["COURSE70"],
    ],
    ["ровно 70", { amount: 70 }, ["COURSE70"]],
    ["ровно 50", { amount: 50 }, ["COURSE50"]],
    ["вчерашняя дата, сутки назад", { amount: 70, receiptAt: new Date(Date.now() - 24 * 3600_000) }, ["COURSE70"]],
  ])("%s", async (_name, overrides, grant) => {
    grantCourses.mockResolvedValueOnce(grant);
    await handleReceiptVerdict(contact, verdict(overrides));
    expect(grantCourses).toHaveBeenCalledTimes(1);
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    // никаких «пришлите другой скриншот» и «передаю Ширин»
    expect(sendToContact).not.toHaveBeenCalled();
    expect(createdData()).toMatchObject({ kind: "valid", linkSent: true, ownerDecision: null });
    expect(createdData().reason).not.toMatch(/не все признаки/);
  });
});

describe("настоящие сомнения идут владельцу, без лишних просьб клиентке", () => {
  it("недоплата 40 сомони: тревога, понятная причина, клиентку не просим присылать ещё", async () => {
    await handleReceiptVerdict(contact, verdict({ amount: 40 }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    const caption = (sendReceiptForReview.mock.calls[0][2] as { caption: string }).caption;
    expect(caption).toMatch(/Что смущает: .*не сходится с ценами/);
    expect(caption).not.toMatch(/не все признаки/);
    // единственное сообщение клиентке — «передаю Ширин», а не «пришлите другой»
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/передаю Ширин/);
  });

  it("получатель не наш (ИИ уверен): тревога сразу", async () => {
    await handleReceiptVerdict(
      contact,
      verdict({ kind: "suspicious", recipientMatches: false, confidence: 90, reason: "номер получателя другой" }),
    );
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0]?.[1] ?? "")).not.toMatch(/ещё один|другой/i);
  });

  it("признаки подделки: тревога, доступ не выдан", async () => {
    await handleReceiptVerdict(contact, verdict({ tamperingSuspected: true }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect((sendReceiptForReview.mock.calls[0][2] as { caption: string }).caption).toMatch(/подделки/);
  });

  it("давнишняя дата (4 суток): тревога", async () => {
    await handleReceiptVerdict(contact, verdict({ receiptAt: new Date(Date.now() - 4 * 24 * 3600_000) }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("скриншот из чёрного списка: тревога и клиентке ничего не обещаем", async () => {
    db.model("blockedReceipt").findUnique.mockResolvedValue({ reason: "подделка" });
    await handleReceiptVerdict(contact, verdict());
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("реально нечитаемый чек: ОДИН раз просим другой скриншот, владельца пока не зовём", async () => {
    await handleReceiptVerdict(
      contact,
      verdict({ amount: null, confidence: 30, recipientMatches: false, kind: "suspicious" }),
    );
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/ещё один/);
  });

  it("нечитаемый чек во второй раз: больше не просим, зовём владельца", async () => {
    const again = fakeContact({ askedAltScreenshotAt: new Date() }) as Parameters<typeof handleReceiptVerdict>[0];
    await handleReceiptVerdict(
      again,
      verdict({ amount: null, confidence: 30, recipientMatches: false, kind: "suspicious", imageHash: "h2" }),
    );
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect(sendToContact.mock.calls.map((c) => String(c[1])).join(" ")).not.toMatch(/ещё один/);
  });
});

describe("два скриншота одного перевода", () => {
  it("второй скриншот после принятого: без выдачи, без тревоги, «уже приняли»", async () => {
    // первый скриншот (650 RUB ≈ 73) уже открыл доступ минуту назад
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.createdAt && where.OR ? { amount: 73, linkSent: true, ownerDecision: null } : null,
    );
    await handleReceiptVerdict(contact, verdict({ imageHash: "hash-second" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(createdData()).toMatchObject({ kind: "duplicate", linkSent: false, ownerDecision: null });
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/уже приняли/);
  });

  it("второй скриншот, пока первый у владельца: молчим, второй карточки нет", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.createdAt && where.OR ? { amount: 71, linkSent: false, ownerDecision: "PENDING" } : null,
    );
    await handleReceiptVerdict(contact, verdict({ imageHash: "hash-second" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(createdData().kind).toBe("duplicate");
  });

  it("соседний разбор успел раньше: выдача вернула пусто, но курс уже доставлен — не тревога", async () => {
    grantCourses.mockResolvedValueOnce([]);
    db.model("purchase").count.mockResolvedValue(1);
    db.model("contact").updateMany.mockResolvedValue({ count: 0 });
    await handleReceiptVerdict(contact, verdict({ imageHash: "hash-race" }));
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(createdData()).toMatchObject({ kind: "duplicate", ownerDecision: null });
  });

  it("тот же скриншот прислан второй раз тем же человеком: строка не затирается, тревоги нет", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue({
      id: "old",
      contactId: contact.id,
      kind: "valid",
      linkSent: true,
      ownerDecision: null,
      awaitingDeliveryChoice: false,
    });
    await handleReceiptVerdict(contact, verdict());
    expect(db.model("receiptCheck").create).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").update).not.toHaveBeenCalled();
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(String(sendToContact.mock.calls[0][1])).toMatch(/уже приняли/);
  });

  it("тот же скриншот, пока чек у владельца: молчим", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue({
      id: "old",
      contactId: contact.id,
      kind: "suspicious",
      linkSent: false,
      ownerDecision: "PENDING",
      ownerAlerts: "[{}]",
      awaitingDeliveryChoice: false,
    });
    await handleReceiptVerdict(contact, verdict());
    expect(db.model("receiptCheck").create).not.toHaveBeenCalled();
    expect(sendReceiptForReview).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("чужой скриншот, уже открывавший доступ другому человеку, по-прежнему стоп", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.OR && where.imageHash === "hash-ds" ? { createdAt: new Date() } : null,
    );
    await handleReceiptVerdict(contact, verdict());
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });
});

describe("допуск в разделе «Цены и даты»", () => {
  it("допуск по умолчанию в форме, меняется и попадает в журнал изменений", () => {
    const next = { ...OFFER_DEFAULTS, payment: { toleranceDown: 6, toleranceUp: 12 } };
    expect(diffOffer(OFFER_DEFAULTS, next)).toEqual([{ field: "payment.toleranceUp", before: "30", after: "12" }]);
  });

  it("слишком большой допуск вниз - это уже недоплата, сервер отказывает", () => {
    const bad = parseOffer({ ...OFFER_DEFAULTS, payment: { toleranceDown: 20, toleranceUp: 30 } });
    expect("errors" in bad && bad.errors["payment.toleranceDown"]).toMatch(/недоплата/);
  });

  it("старый экран без допуска сохраняется, как раньше", () => {
    const { payment: _omit, ...legacy } = OFFER_DEFAULTS;
    expect("offer" in parseOffer(legacy)).toBe(true);
  });
});

describe("после просьбы «пришлите другой скриншот»", () => {
  it("тот же скриншот, карточка владельцу ещё НЕ уходила: разбор идёт дальше, чек не глотается", async () => {
    db.model("receiptCheck").findUnique.mockResolvedValue({
      id: "old", contactId: contact.id, kind: "suspicious", linkSent: false, ownerDecision: "PENDING", ownerAlerts: null, awaitingDeliveryChoice: false,
    });
    db.model("receiptCheck").update.mockResolvedValue({ id: "old" });
    const asked = fakeContact({ askedAltScreenshotAt: new Date() }) as Parameters<typeof handleReceiptVerdict>[0];
    await handleReceiptVerdict(asked, verdict({ recipientMatches: false, kind: "suspicious", confidence: 90 }));
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("другой скриншот сразу после просьбы, первый без карточки: не «повтор», выдаётся", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const pendingNeedsCard = JSON.stringify(where.OR ?? []).includes('"ownerAlerts":{"not":null}');
      // ожидающий чек без карточки в «тот же перевод» не засчитывается
      return where.kind && where.OR && !pendingNeedsCard ? { amount: 71, linkSent: false, ownerDecision: "PENDING" } : null;
    });
    await handleReceiptVerdict(contact, verdict({ imageHash: "second" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });
});

describe("номер операции и рубли", () => {
  it("тот же номер операции у другого человека: стоп", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.transactionId ? { contactId: "someone-else", createdAt: new Date() } : null
    );
    await handleReceiptVerdict(contact, verdict({ transactionId: "TX123456789" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("номер операции сохраняется в строке чека", async () => {
    await handleReceiptVerdict(contact, verdict({ transactionId: "TX123456789" }));
    expect((createdData() as unknown as { transactionId: string }).transactionId).toBe("TX123456789");
  });

  it("только рубли: 650 RUB пересчитываются по курсу и проходят", async () => {
    await handleReceiptVerdict(contact, verdict({ amount: 650, currency: "RUB", imageHash: "rub" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });
});

describe("мошеннические сценарии (ревью)", () => {
  it("курс за 70 уже куплен, пришёл старый чек на 70 без даты и номера: курс за 50 НЕ открывается", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70" }]);
    await handleReceiptVerdict(contact, verdict({ amount: 70, receiptAt: null, imageHash: "old70" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
    expect((sendReceiptForReview.mock.calls[0][2] as { caption: string }).caption).toMatch(/уже оплачивали/);
  });

  it("то же с датой: сумма ближе к цене купленного курса - всё равно владельцу", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE70" }]);
    await handleReceiptVerdict(contact, verdict({ amount: 71.45, receiptAt: new Date(), imageHash: "old71" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("курс за 50 уже куплен, честный чек на 70 со свежей датой: выдаётся курс за 70", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE50" }]);
    await handleReceiptVerdict(contact, verdict({ amount: 70, receiptAt: new Date(), imageHash: "second-course" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("повтор с суммой 71.45 против прежних 70 спустя часы: запас 5 сомони, владельцу", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      Array.isArray(where.OR) && typeof where.amount === "object" ? { createdAt: new Date() } : null
    );
    await handleReceiptVerdict(contact, verdict({ amount: 71.45, receiptAt: new Date(), imageHash: "again" }));
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendReceiptForReview).toHaveBeenCalledTimes(1);
  });

  it("первая покупка, ни даты, ни номера: проходит (сумма и получатель в порядке)", async () => {
    await handleReceiptVerdict(contact, verdict({ amount: 70, receiptAt: null, imageHash: "first" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("чек с номером операции без даты у покупавшей клиентки проходит", async () => {
    db.model("purchase").findMany.mockResolvedValue([{ course: "COURSE50" }]);
    await handleReceiptVerdict(contact, verdict({ amount: 70, receiptAt: null, transactionId: "TX998877665", imageHash: "withtx" }));
    expect(grantCourses).toHaveBeenCalledTimes(1);
  });

  it("тот же скриншот от другого человека: карточка не молчит, владельцу уходит уведомление, доступ не выдан", async () => {
    db.model("receiptCheck").findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.OR && where.imageHash === "hash-ds" ? { createdAt: new Date() } : null
    );
    db.model("receiptCheck").create.mockRejectedValue(
      Object.assign(Object.create((await import("@prisma/client")).Prisma.PrismaClientKnownRequestError.prototype), { code: "P2002" })
    );
    db.model("receiptCheck").findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.imageHash ? (where.imageHash === "hash-ds" && db.model("receiptCheck").create.mock.calls.length > 0 ? { id: "x", contactId: "someone-else" } : null) : null
    );
    db.model("contact").findUnique.mockResolvedValue({ username: "other", igUserId: "ig-o" });
    settings.telegramBotToken = "t";
    await handleReceiptVerdict(contact, verdict());
    expect(grantCourses).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toMatch(/уже присылал другой человек/);
  });
});
