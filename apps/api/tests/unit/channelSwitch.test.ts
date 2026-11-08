import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async (..._a: unknown[]) => "mid-1" as string | null);
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
const createOneTimeInviteLink = vi.fn(async (..._a: unknown[]) => "https://t.me/+NEWINVITE" as string | null);
const revokeInviteLink = vi.fn(async (..._a: unknown[]) => true);

vi.mock("../../src/instagram.js", () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  channelOf: (c: { channel: string }) => c.channel,
}));
vi.mock("../../src/whatsapp/transport.js", () => ({
  sendWhatsAppText: (...a: unknown[]) => sendText(...a),
  sendWhatsAppAttachment: vi.fn(),
}));
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  createOneTimeInviteLink: (...a: unknown[]) => createOneTimeInviteLink(...a),
  revokeInviteLink: (...a: unknown[]) => revokeInviteLink(...a),
}));
vi.mock("../../src/course/delivery.js", async (orig) => ({
  ...(await orig<typeof import("../../src/course/delivery.js")>()),
  coursePlatformReady: vi.fn(async () => true),
}));
vi.mock("../../src/courses.js", async (orig) => ({
  ...(await orig<typeof import("../../src/courses.js")>()),
  chatIdFor: vi.fn(async () => "-100500"),
}));

import {
  switchCourseChannel,
  handleSwitchRequest,
  approveSwitchByOwner,
  parseSwitchRequest,
  isFreeSwitch,
} from "../../src/course/channelSwitch.js";
import { recoveryCodeFor } from "../../src/course/linkCode.js";
import { openByLink } from "../../src/course/access.js";
import { maybeRestoreAccess, looksLikeAccessRequest } from "../../src/course/recovery.js";
import type { Contact } from "@prisma/client";
import type { Request, Response } from "express";

const OLD_CODE = "Ab3kQ9xZpm";
const DAY = 86_400_000;
const TG_LINK = "https://t.me/+OLDINVITE";

type Row = Record<string, unknown>;
let contactRow: Row;
let purchaseRows: Row[];
/** Действующие покупки ДРУГИХ контактов с тем же Telegram (запрос removeContactFromGroups). */
let otherPurchaseRows: Row[];

type TgReply = unknown | ((body: Record<string, unknown>) => unknown);
/** Подмена Telegram Bot API: по умолчанию человек — обычный участник, всё проходит. */
function stubTelegram(over: Record<string, TgReply> = {}) {
  const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    const given = over[method];
    const reply =
      given === undefined
        ? method === "getChatMember"
          ? { ok: true, result: { status: "member" } }
          : { ok: true, result: true }
        : typeof given === "function"
          ? (given as (b: Record<string, unknown>) => unknown)(body)
          : given;
    return { json: async () => reply };
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = (method: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));
  return { fetchMock, calls };
}

function baseContact(over: Row = {}): Row {
  return fakeContact({
    id: "c-1",
    channel: "INSTAGRAM",
    igUserId: "ig-1",
    name: "Гулнора",
    preferredLanguage: "ru",
    accessTokenId: OLD_CODE,
    accessIssuedAt: new Date(Date.now() - 2 * DAY),
    accessRevokedAt: null,
    spamBlockedAt: null,
    courseDeliveryChoice: "web",
    inviteLink: null,
    telegramUserId: null,
    joinedGroupAt: null,
    deviceSwaps: 0,
    deviceSwapAt: null,
    ...over,
  });
}

function purchase(over: Row = {}): Row {
  return {
    id: "p-1",
    contactId: "c-1",
    course: "COURSE50",
    revokedAt: null,
    createdAt: new Date(Date.now() - 10 * DAY),
    firstOpenedAt: new Date(Date.now() - 9 * DAY),
    joinedAt: null,
    inviteLink: null,
    ...over,
  };
}

/** Мини-база: Contact хранит состояние, updateMany соблюдает проверку «прежняя ещё та же» (как настоящая). */
function wireDb(db: PrismaMock) {
  db.model("contact").findUnique.mockImplementation(async ({ where }: { where: Row }) => {
    if (where.id) return where.id === contactRow.id ? { ...contactRow } : null;
    if (where.accessTokenId) return where.accessTokenId === contactRow.accessTokenId ? { ...contactRow } : null;
    return null;
  });
  db.model("contact").updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    for (const [k, v] of Object.entries(where)) {
      const cur = contactRow[k] ?? null;
      const a = cur instanceof Date ? cur.getTime() : cur;
      const b = v instanceof Date ? (v as Date).getTime() : v;
      if (a !== b) return { count: 0 };
    }
    Object.assign(contactRow, data);
    return { count: 1 };
  });
  db.model("contact").update.mockImplementation(async ({ data }: { data: Row }) => {
    Object.assign(contactRow, data);
    return { ...contactRow };
  });
  db.model("purchase").findMany.mockImplementation(async ({ where }: { where: Row }) => {
    if (where.contact) return otherPurchaseRows;
    return purchaseRows.filter((p) => (where.revokedAt === null ? p.revokedAt === null : true));
  });
  db.model("purchase").updateMany.mockImplementation(async ({ data }: { data: Row }) => {
    for (const p of purchaseRows) if (!p.revokedAt) Object.assign(p, data);
    return { count: 1 };
  });
  db.model("purchase").update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    Object.assign(purchaseRows.find((p) => p.id === where.id) ?? {}, data);
    return {};
  });
  db.model("telegramInvite").findMany.mockResolvedValue([]);
  db.model("device").deleteMany.mockResolvedValue({ count: 2 });
  db.model("device").findMany.mockResolvedValue([{ id: "d-1", contactId: "c-1", userAgent: "Android" }, { id: "d-2", contactId: "c-1", userAgent: "Android" }]);
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key === "telegramBotToken" ? { value: "token" } : null,
  );
}

describe("parseSwitchRequest", () => {
  it("«нет телеграма» и «хочу на сайте» — просьба на сайт; «хочу в телеграм» — на Telegram", () => {
    for (const t of [
      "у меня нет телеграма",
      "Телеграм нет, дайте ссылку",
      "не могу зайти в группу",
      "хочу на сайте смотреть",
      "пришлите ссылку на сайт",
      "телеграм надорам",
      "линк ба сайт диҳед",
    ]) {
      expect(parseSwitchRequest(t), t).toBe("web");
    }
    for (const t of [
      "хочу в телеграм",
      "пришлите приглашение в группу",
      "переведите в Telegram",
      "дар Telegram мехоҳам",
      "Здравствуйте! Хочу в Telegram, пришлите приглашение в группу. Мой код: 7F3A-91C2",
      "Ассалому алейкум! Дар Telegram мехоҳам, линк ба гурӯҳ диҳед",
    ]) {
      expect(parseSwitchRequest(t), t).toBe("telegram");
    }
  });
  it("посторонние фразы не срабатывают", () => {
    for (const t of ["сколько стоит курс", "видела ваш телеграм канал", "на сайте цена другая", "добрый день", ""]) {
      expect(parseSwitchRequest(t), t).toBeNull();
    }
  });
});

describe("isFreeSwitch", () => {
  it("первые сутки и «ещё не открывала» — бесплатно, иначе нет", () => {
    expect(isFreeSwitch([{ createdAt: new Date(), firstOpenedAt: new Date(), joinedAt: null }])).toBe(true);
    expect(isFreeSwitch([{ createdAt: new Date(Date.now() - 5 * DAY), firstOpenedAt: null, joinedAt: null }])).toBe(
      true,
    );
    expect(
      isFreeSwitch([{ createdAt: new Date(Date.now() - 5 * DAY), firstOpenedAt: new Date(), joinedAt: null }]),
    ).toBe(false);
    expect(
      isFreeSwitch([{ createdAt: new Date(Date.now() - 5 * DAY), firstOpenedAt: null, joinedAt: new Date() }]),
    ).toBe(false);
    expect(isFreeSwitch([])).toBe(false);
  });
});

describe("одна действующая ссылка на человека", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    sendText.mockReset().mockResolvedValue("mid-1");
    sendTelegramMessage.mockClear();
    createOneTimeInviteLink.mockReset().mockResolvedValue("https://t.me/+NEWINVITE");
    revokeInviteLink.mockReset().mockResolvedValue(true);
    contactRow = baseContact();
    purchaseRows = [purchase()];
    otherPurchaseRows = [];
    wireDb(db);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restorePrisma();
  });

  const asContact = () => ({ ...contactRow }) as unknown as Contact;

  it("ГЛАВНОЕ: сайт -> Telegram: старая ссылка перестаёт открывать, устройства удалены, приглашение выдано", async () => {
    const outcome = await switchCourseChannel(asContact(), "telegram", "bot");

    expect(outcome).toBe("switched");
    expect(contactRow.courseDeliveryChoice).toBe("telegram");
    expect(contactRow.accessTokenId).not.toBe(OLD_CODE);
    expect((contactRow.accessIssuedAt as Date).getTime()).toBe(0);
    expect(String(sendText.mock.calls[0][1])).toContain("https://t.me/+NEWINVITE");
    expect(String(sendText.mock.calls[0][1])).toContain("Ссылка на сайт больше не открывает уроки");
    expect(db.model("device").deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["d-1", "d-2"] } } });
    expect(purchaseRows[0].inviteLink).toBe("https://t.me/+NEWINVITE");
    // Старая сайтовая ссылка из переписки больше не находит владельца.
    const res = await openByLink({ headers: {} } as Request, {} as Response, OLD_CODE);
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    // «Мёртвый» код тоже не открывает, даже угаданный (срок выставлен в 1970).
    const dead = await openByLink({ headers: {} } as Request, {} as Response, String(contactRow.accessTokenId));
    expect(dead).toMatchObject({ ok: false, reason: "link_expired" });
  });

  it("Telegram -> сайт: приглашение отозвано, выдана новая ссылка, она записана и работает как единственная", async () => {
    contactRow = baseContact({
      courseDeliveryChoice: "telegram",
      inviteLink: TG_LINK,
      accessTokenId: null,
      accessIssuedAt: null,
    });
    purchaseRows = [purchase({ inviteLink: TG_LINK, firstOpenedAt: null })];

    const outcome = await switchCourseChannel(asContact(), "web", "bot");

    expect(outcome).toBe("switched");
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100500", TG_LINK);
    const sent = String(sendText.mock.calls[0][1]);
    expect(sent).toContain("Приглашение в группу Telegram больше не действует");
    expect(sent).toContain(`/l/${contactRow.accessTokenId}`);
    expect(contactRow.courseDeliveryChoice).toBe("web");
    expect(contactRow.inviteLink).toBeNull();
    expect(purchaseRows[0].inviteLink).toContain(`/l/${contactRow.accessTokenId}`);
    // Приглашение отозвано ПОСЛЕ доставки сайта.
    expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(revokeInviteLink.mock.invocationCallOrder[0]);
  });

  it("отозванную покупку переключение не оживляет: ничего не меняется и ничего не уходит", async () => {
    purchaseRows = [purchase({ revokedAt: new Date() })];

    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("revoked");
    expect(await switchCourseChannel(asContact(), "web", "owner")).toBe("revoked");

    expect(contactRow.accessTokenId).toBe(OLD_CODE);
    expect(sendText).not.toHaveBeenCalled();
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(revokeInviteLink).not.toHaveBeenCalled();
    expect(purchaseRows[0].revokedAt).not.toBeNull();
    expect(purchaseRows[0].inviteLink).toBeNull();
  });

  it("доступ отозван на контакте — тоже ничего", async () => {
    contactRow = baseContact({ accessRevokedAt: new Date() });
    expect(await switchCourseChannel(asContact(), "telegram", "owner")).toBe("revoked");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("уже на нужном способе — менять нечего, ничего не отправляем", async () => {
    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("already");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("приглашение не доставилось: прежняя сайтовая ссылка возвращена, новые приглашения отозваны, способ не меняется", async () => {
    sendText.mockResolvedValue(null);

    const outcome = await switchCourseChannel(asContact(), "telegram", "bot");

    expect(outcome).toBe("failed");
    expect(contactRow.accessTokenId).toBe(OLD_CODE);
    expect(contactRow.courseDeliveryChoice).toBe("web");
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100500", "https://t.me/+NEWINVITE");
  });

  it("сайтовая ссылка не доставилась: приглашение в группу осталось действующим (человек не остаётся ни с чем)", async () => {
    contactRow = baseContact({
      courseDeliveryChoice: "telegram",
      inviteLink: TG_LINK,
      accessTokenId: null,
      accessIssuedAt: null,
    });
    purchaseRows = [purchase({ inviteLink: TG_LINK })];
    sendText.mockRejectedValue(new Error("network"));

    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("failed");

    expect(revokeInviteLink).not.toHaveBeenCalled();
    expect(contactRow.accessTokenId).toBeNull();
    expect(contactRow.courseDeliveryChoice).toBe("telegram");
  });

  it("Telegram не дал приглашение: сайтовая ссылка жива, человек ничего не теряет", async () => {
    createOneTimeInviteLink.mockResolvedValue(null);

    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("unavailable");

    expect(contactRow.accessTokenId).toBe(OLD_CODE);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("гонка: пока шла отправка, ссылку заменили другим путём — откат её не затирает", async () => {
    sendText.mockImplementation(async () => {
      contactRow.accessTokenId = "Zz9yX8wVu7"; // кто-то выдал свою
      return null;
    });
    await switchCourseChannel(asContact(), "telegram", "bot");
    expect(contactRow.accessTokenId).toBe("Zz9yX8wVu7");
  });

  it("лимит: за 30 дней уже был перенос и канал уже открывали — бот не делает, владельцу карточка с кнопкой", async () => {
    contactRow = baseContact({ deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 3 * DAY) });

    const outcome = await handleSwitchRequest(asContact(), "telegram", "ru");

    expect(outcome).toBe("limit");
    expect(contactRow.accessTokenId).toBe(OLD_CODE);
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toBe("Передала Ширин: она посмотрит и ответит вам.");
    expect(String(sendText.mock.calls[0][1])).not.toMatch(/\d/);
    expect(JSON.stringify(sendTelegramMessage.mock.calls[0][4])).toContain(`mn:sw:c-1:t`);
  });

  it("первые сутки после покупки переключение не тратит месячный счётчик, даже если перенос уже был", async () => {
    contactRow = baseContact({ deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 3 * DAY) });
    purchaseRows = [purchase({ createdAt: new Date(Date.now() - 3_600_000), firstOpenedAt: new Date() })];

    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("switched");
    expect(contactRow.deviceSwaps).toBe(1);
  });

  it("позже суток, но уже открывала: переключение считается в общий месячный счётчик", async () => {
    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("switched");
    expect(contactRow.deviceSwaps).toBe(1);
    expect(contactRow.deviceSwapAt).toBeInstanceOf(Date);
  });

  it("до первого открытия — без счётчика", async () => {
    purchaseRows = [purchase({ firstOpenedAt: null })];
    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("switched");
    expect(contactRow.deviceSwaps).toBe(0);
  });

  const inGroupContact = (over: Row = {}) =>
    baseContact({
      courseDeliveryChoice: "telegram",
      inviteLink: TG_LINK,
      joinedGroupAt: new Date(),
      telegramUserId: "777",
      accessTokenId: null,
      accessIssuedAt: null,
      ...over,
    });
  const inGroupPurchase = (over: Row = {}) => purchase({ inviteLink: TG_LINK, joinedAt: new Date(), ...over });
  const banBody = (calls: (m: string) => unknown[][]) =>
    JSON.parse(String((calls("banChatMember")[0][1] as { body: string }).body)) as Record<string, unknown>;

  it("человек в группе просит сайт: бот СРАЗУ отзывает приглашение, удаляет из группы и выдаёт сайт; карточки владельцу нет", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram();

    expect(await handleSwitchRequest(asContact(), "web", "ru")).toBe("switched");

    expect(calls("getChatMember")).toHaveLength(1);
    expect(calls("banChatMember")).toHaveLength(1);
    expect(banBody(calls)).toEqual({ chat_id: "-100500", user_id: 777 });
    expect(calls("unbanChatMember")).toHaveLength(1);
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100500", TG_LINK);
    expect(contactRow.courseDeliveryChoice).toBe("web");
    expect(contactRow.joinedGroupAt).toBeNull();
    expect(purchaseRows[0].joinedAt).toBeNull();
    expect(String(sendText.mock.calls[0][1])).toContain("/l/");
    // Журнал: кто, где, когда.
    expect(db.model("accessEvent").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: "c-1", action: "removed", actor: "bot" }),
    });
    const detail = String(db.model("accessEvent").create.mock.calls[0][0].data.detail);
    expect(detail).toContain("777");
    expect(detail).toContain("-100500");
    // Всё прошло — хозяйке ничего не пишем.
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("кнопка владельца для человека в группе: то же самое, текст спокойный", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram();

    expect(await approveSwitchByOwner("c-1", "web")).toBe(true);

    expect(calls("banChatMember")).toHaveLength(1);
    expect(String(sendText.mock.calls[0][1])).toContain("Теперь ваши уроки на сайте");
    expect(String(sendText.mock.calls[0][1])).not.toContain("Ширин");
  });

  it("бан не прошёл (у бота нет прав): сайт выдан, человек в группе, хозяйка получает тревогу, отметки не сброшены", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram({ banChatMember: { ok: false, description: "Bad Request: not enough rights" } });

    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("switched");

    expect(calls("banChatMember")).toHaveLength(2); // повтор
    expect(calls("unbanChatMember")).toHaveLength(0);
    expect(contactRow.joinedGroupAt).not.toBeNull();
    expect(purchaseRows[0].joinedAt).not.toBeNull();
    expect(db.model("accessEvent").create).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("убрать не удалось");
  });

  it("разбан не прошёл: повторяем три раза и зовём хозяйку (человек остался в чёрном списке)", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram({ unbanChatMember: { ok: false, description: "Bad Request: timeout" } });

    await switchCourseChannel(asContact(), "web", "bot");

    expect(calls("unbanChatMember")).toHaveLength(3);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("снять бан не вышло");
  });

  it("Telegram-идентификатор пуст: из группы не удалено, хозяйка предупреждена честно, сайт всё равно выдан", async () => {
    contactRow = inGroupContact({ telegramUserId: null });
    purchaseRows = [inGroupPurchase()];
    const { fetchMock } = stubTelegram();

    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("switched");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Telegram-идентификатор неизвестен");
    expect(contactRow.joinedGroupAt).not.toBeNull();
  });

  it("не в группе и идентификатора нет — тихо, без тревоги", async () => {
    contactRow = baseContact({
      courseDeliveryChoice: "telegram",
      inviteLink: TG_LINK,
      accessTokenId: null,
      accessIssuedAt: null,
    });
    purchaseRows = [purchase({ inviteLink: TG_LINK })];
    stubTelegram();

    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("switched");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("администратор или создатель группы не удаляется: бан не вызывается, хозяйка видит причину", async () => {
    for (const status of ["administrator", "creator"]) {
      sendTelegramMessage.mockClear();
      contactRow = inGroupContact();
      purchaseRows = [inGroupPurchase()];
      const { calls } = stubTelegram({ getChatMember: { ok: true, result: { status } } });

      expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("switched");

      expect(calls("banChatMember"), status).toHaveLength(0);
      expect(String(sendTelegramMessage.mock.calls[0][2]), status).toContain("администратор группы");
      expect(contactRow.joinedGroupAt, status).not.toBeNull();
    }
  });

  it("не удалось узнать, кто это (getChatMember упал): вслепую не баним", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram({ getChatMember: { ok: false, description: "Too Many Requests" } });

    await switchCourseChannel(asContact(), "web", "bot");

    expect(calls("banChatMember")).toHaveLength(0);
    expect(sendTelegramMessage).toHaveBeenCalled();
  });

  it("человек уже вышел сам (left): не баним, отметки сбрасываем", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram({ getChatMember: { ok: true, result: { status: "left" } } });

    await switchCourseChannel(asContact(), "web", "bot");

    expect(calls("banChatMember")).toHaveLength(0);
    expect(contactRow.joinedGroupAt).toBeNull();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("два контакта одного человека: у второго есть действующая покупка на тот же курс — из этой группы не удаляем", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    otherPurchaseRows = [{ course: "COURSE50" }];
    const { calls } = stubTelegram();

    expect(await switchCourseChannel(asContact(), "web", "bot")).toBe("switched");

    expect(calls("banChatMember")).toHaveLength(0);
    expect(revokeInviteLink).toHaveBeenCalled(); // приглашение этого контакта всё равно отозвано
  });

  it("банит только в группе купленного курса, не во всех; приглашение отзывается только там", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase({ course: "COURSE70" })];
    const courses = await import("../../src/courses.js");
    vi.mocked(courses.chatIdFor).mockImplementation(async (c: unknown) => (c === "COURSE70" ? "-100700" : "-100500"));
    const { calls } = stubTelegram();

    await switchCourseChannel(asContact(), "web", "bot");

    expect(calls("banChatMember")).toHaveLength(1);
    expect(banBody(calls).chat_id).toBe("-100700");
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100700", TG_LINK);
    expect(revokeInviteLink).not.toHaveBeenCalledWith("token", "-100500", TG_LINK);
    vi.mocked(courses.chatIdFor).mockImplementation(async () => "-100500");
  });

  it("/ссылка владельца для человека в группе: приглашение отозвано, из группы удалён, выбор «сайт»", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase()];
    const { calls } = stubTelegram();

    const { closeTelegramDoor } = await import("../../src/course/channelSwitch.js");
    expect(await closeTelegramDoor("c-1")).toBe(true);

    expect(calls("banChatMember")).toHaveLength(1);
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100500", TG_LINK);
    expect(contactRow.courseDeliveryChoice).toBe("web");
    expect(contactRow.inviteLink).toBeNull();
    expect(db.model("accessEvent").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "removed", actor: "owner" }),
    });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("у человека на сайте и без группы closeTelegramDoor ничего не делает", async () => {
    stubTelegram();
    const { closeTelegramDoor } = await import("../../src/course/channelSwitch.js");
    expect(await closeTelegramDoor("c-1")).toBe(false);
    expect(revokeInviteLink).not.toHaveBeenCalled();
  });

  it("подтверждение «перевести?» не обещает «пришлю сразу», когда просьба уйдёт Ширин (лимит), и без цифр", async () => {
    contactRow = inGroupContact({ deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 3 * DAY) });
    purchaseRows = [inGroupPurchase()];
    db.model("receiptCheck").count.mockResolvedValue(1);

    await maybeRestoreAccess(asContact(), "у меня нет телеграма, хочу на сайте");

    const text = String(sendText.mock.calls[0][1]);
    expect(text).toContain("разрешения Ширин");
    expect(text).not.toContain("сразу");
    expect(text).not.toMatch(/\d/);
  });

  it("подтверждение для прямого перевода говорит, что место в группе закроется", async () => {
    contactRow = inGroupContact();
    purchaseRows = [inGroupPurchase({ firstOpenedAt: null })];
    db.model("receiptCheck").count.mockResolvedValue(1);

    await maybeRestoreAccess(asContact(), "у меня нет телеграма, хочу на сайте");

    const text = String(sendText.mock.calls[0][1]);
    expect(text).toContain("место в группе закроется");
    expect(text).toContain("пришлю сразу");
  });

  it("лимит: владельцу карточка, подпись кнопки по joinedGroupAt", async () => {
    contactRow = inGroupContact({ deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 3 * DAY) });
    purchaseRows = [inGroupPurchase()];
    stubTelegram();

    expect(await handleSwitchRequest(asContact(), "web", "ru")).toBe("limit");

    expect(JSON.stringify(sendTelegramMessage.mock.calls[0][4])).toContain("Перевести на сайт и убрать из группы");
    expect(JSON.stringify(sendTelegramMessage.mock.calls[0][4])).toContain("mn:sw:c-1:w");
  });

  it("кнопка владельца снимает месячный лимит, но не оживляет отозванную покупку", async () => {
    contactRow = baseContact({ deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 3 * DAY) });
    expect(await approveSwitchByOwner("c-1", "telegram")).toBe(true);
    expect(contactRow.deviceSwaps).toBe(1); // владелец счётчик не тратит

    contactRow = baseContact({ courseDeliveryChoice: "telegram", accessTokenId: null, accessIssuedAt: null });
    purchaseRows = [purchase({ revokedAt: new Date() })];
    expect(await approveSwitchByOwner("c-1", "web")).toBe(false);
  });

  it("две покупки: приглашение на каждую группу, все в одном сообщении", async () => {
    purchaseRows = [purchase(), purchase({ id: "p-2", course: "COURSE70" })];
    createOneTimeInviteLink.mockResolvedValueOnce("https://t.me/+ONE").mockResolvedValueOnce("https://t.me/+TWO");

    expect(await switchCourseChannel(asContact(), "telegram", "bot")).toBe("switched");

    const sent = String(sendText.mock.calls[0][1]);
    expect(sent).toContain("https://t.me/+ONE");
    expect(sent).toContain("https://t.me/+TWO");
    expect(purchaseRows.map((p) => p.inviteLink)).toEqual(["https://t.me/+ONE", "https://t.me/+TWO"]);
  });

  it("таджикский: строго «шумо»", async () => {
    contactRow = baseContact({ preferredLanguage: "tg" });
    await switchCourseChannel(asContact(), "telegram", "bot", "tg");
    expect(String(sendText.mock.calls[0][1])).toContain("Шуморо ба Telegram гузарондам");
  });

  it("из чата бота: «нет телеграма, хочу на сайте» -> бот сам переключает (чек в базе есть)", async () => {
    contactRow = baseContact({
      courseDeliveryChoice: "telegram",
      inviteLink: TG_LINK,
      accessTokenId: null,
      accessIssuedAt: null,
    });
    purchaseRows = [purchase({ inviteLink: TG_LINK })];
    db.model("receiptCheck").count.mockResolvedValue(1);
    const text = "у меня нет телеграма, хочу на сайте";
    expect(looksLikeAccessRequest(text)).toBe(true);

    // Шаг 1: только вопрос «перевести вас?», ничего не меняется.
    const first = await maybeRestoreAccess(asContact(), text);
    expect(first).toEqual({ handled: true, outcome: "escalated" });
    expect(String(sendText.mock.calls[0][1])).toContain("ответьте «да»");
    expect(revokeInviteLink).not.toHaveBeenCalled();
    expect(contactRow.courseDeliveryChoice).toBe("telegram");

    // Шаг 2: «да» — переключение.
    sendText.mockClear();
    const result = await maybeRestoreAccess(asContact(), "да");
    expect(result).toEqual({ handled: true, outcome: "reissued" });
    expect(revokeInviteLink).toHaveBeenCalledWith("token", "-100500", TG_LINK);
    expect(contactRow.courseDeliveryChoice).toBe("web");
    expect(String(sendText.mock.calls[0][1])).toContain("/l/");
  });

  it("«да» без вопроса ничего не делает, а любой другой ответ снимает вопрос", async () => {
    db.model("receiptCheck").count.mockResolvedValue(1);
    expect(await maybeRestoreAccess(asContact(), "да")).toEqual({ handled: false });
    await maybeRestoreAccess(asContact(), "хочу в телеграм");
    await maybeRestoreAccess(asContact(), "а сколько стоит второй курс");
    expect(await maybeRestoreAccess(asContact(), "да")).toEqual({ handled: false });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(contactRow.accessTokenId).toBe(OLD_CODE);
  });

  it("обычные вопросы про чек и оплату не принимаются за просьбу переключить", () => {
    for (const t of [
      "Можно в тг скину чек?",
      "Можно на сайте оплатить второй курс?",
      "Курс на сайте сколько стоит?",
      "Дайте ссылку на группу для вопросов",
      "Ссылка в группу не открывается",
      "Видео в телеграме не открывается",
    ]) {
      expect(parseSwitchRequest(t), t).toBeNull();
    }
  });

  it("код с экрана ошибки из ДРУГОГО чата: бот не переключает и не советует /ссылка, владельцу кнопка перевода покупателя", async () => {
    const buyer = { ...baseContact({ id: "11111111-1111-4111-8111-111111111111", igUserId: "ig-buyer" }) };
    const code = recoveryCodeFor(String(buyer.accessTokenId));
    db.model("contact").findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      where.accessTokenId === buyer.accessTokenId || where.id === buyer.id ? { ...buyer } : { ...contactRow },
    );
    db.model("contact").findMany.mockResolvedValue([buyer]);
    purchaseRows = [purchase({ contactId: String(buyer.id) })];
    const other = baseContact({ id: "c-9", channel: "WHATSAPP", igUserId: "992900000000" });

    const result = await maybeRestoreAccess(
      other as unknown as Contact,
      `Здравствуйте! Хочу в Telegram, пришлите приглашение в группу. Мой код: ${code}`,
    );

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(JSON.stringify(sendTelegramMessage.mock.calls.at(-1))).toContain(`mn:sw:${String(buyer.id)}:t`);
    expect(JSON.stringify(sendTelegramMessage.mock.calls)).not.toContain("/ссылка");
  });

  it("из чата бота без чека в базе переключение не делается", async () => {
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("purchase").count.mockResolvedValue(0);

    const result = await maybeRestoreAccess(asContact(), "хочу в телеграм");

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(contactRow.accessTokenId).toBe(OLD_CODE);
  });
});
