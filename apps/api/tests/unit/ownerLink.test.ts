import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const createOneTimeInviteLink = vi.fn(async (_t: string, chatId: string) => `https://t.me/+NEW${chatId}`);
const revokeInviteLink = vi.fn(async () => true);
const getChatMemberStatus = vi.fn(async (): Promise<string | null> => "left");
vi.mock("../../src/telegram.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/telegram.js")>()),
  createOneTimeInviteLink: (...a: [string, string]) => createOneTimeInviteLink(...a),
  revokeInviteLink: (...a: unknown[]) => (revokeInviteLink as (...x: unknown[]) => unknown)(...a),
  getChatMemberStatus: (...a: unknown[]) => (getChatMemberStatus as (...x: unknown[]) => unknown)(...a),
}));

const issueCourseLink = vi.fn(async () => "https://shirinsweets.online/l/NEWCODE");
vi.mock("../../src/course/delivery.js", () => ({
  issueCourseLink: (...a: unknown[]) => (issueCourseLink as (...x: unknown[]) => unknown)(...a),
}));

const rememberInviteLink = vi.fn(async () => undefined);
vi.mock("../../src/groupAccess.js", () => ({
  rememberInviteLink: (...a: unknown[]) => (rememberInviteLink as (...x: unknown[]) => unknown)(...a),
}));

import { createOffer, findPeople, issueOwnerLink, OFFER_TTL_MS, takeOffer } from "../../src/course/ownerLink.js";

let db: PrismaMock;

const SETTINGS: Record<string, string> = {
  telegramBotToken: "бот-токен",
  telegramChatId50: "-100500",
  telegramChatId70: "-100700",
};

const baseContact = {
  id: "c1",
  username: "malika",
  igUserId: "ig-1",
  studentFirstName: "Малика",
  studentLastName: null,
  telegramUserId: null,
  joinedGroupAt: null,
  accessRevokedAt: null,
  spamBlockedAt: null,
};

const purchase = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  contactId: "c1",
  course: "COURSE50",
  inviteLink: null,
  joinedAt: null,
  revokedAt: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  ...over,
});

beforeEach(() => {
  db = mockPrisma();
  db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    SETTINGS[where.key] ? { key: where.key, value: SETTINGS[where.key] } : null,
  );
  db.model("contact").findUnique.mockResolvedValue(baseContact);
  db.model("purchase").findMany.mockResolvedValue([purchase()]);
  createOneTimeInviteLink.mockClear();
  revokeInviteLink.mockClear();
  getChatMemberStatus.mockReset().mockResolvedValue("left");
  issueCourseLink.mockClear();
  rememberInviteLink.mockClear();
});

afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("Ссылка на сайт", () => {
  it("выпускает свежую ссылку штатным способом (прошлая гаснет) и называет курсы", async () => {
    const r = await issueOwnerLink("c1", "web");
    expect(r).toEqual({ ok: true, kind: "web", url: "https://shirinsweets.online/l/NEWCODE", courses: ["COURSE50"] });
    expect(issueCourseLink).toHaveBeenCalledWith("c1", { automatic: false });
  });

  it("отобранный доступ или спам — ссылки нет", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, accessRevokedAt: new Date() });
    expect(await issueOwnerLink("c1", "web")).toEqual({ ok: false, reason: "blocked" });
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, spamBlockedAt: new Date() });
    expect(await issueOwnerLink("c1", "web")).toEqual({ ok: false, reason: "blocked" });
    expect(issueCourseLink).not.toHaveBeenCalled();
  });

  it("нет действующей покупки — выдавать не за что", async () => {
    db.model("purchase").findMany.mockResolvedValue([]);
    expect(await issueOwnerLink("c1", "web")).toEqual({ ok: false, reason: "no-purchase" });
    expect(issueCourseLink).not.toHaveBeenCalled();
  });

  it("человека нет в базе", async () => {
    db.model("contact").findUnique.mockResolvedValue(null);
    expect(await issueOwnerLink("zzz", "web")).toEqual({ ok: false, reason: "not-found" });
  });

  it("адрес платформы не задан", async () => {
    issueCourseLink.mockResolvedValueOnce(null as never);
    expect(await issueOwnerLink("c1", "web")).toEqual({ ok: false, reason: "no-base" });
  });
});

describe("Приглашение в группу Telegram", () => {
  it("даёт приглашение на не вошедший курс и НЕ трогает ссылку на сайт", async () => {
    const r = await issueOwnerLink("c1", "telegram");
    expect(r).toEqual({ ok: true, kind: "telegram", links: [{ course: "COURSE50", url: "https://t.me/+NEW-100500" }] });
    expect(issueCourseLink).not.toHaveBeenCalled();
    // Сайтовые поля контакта не меняются ни при каких обстоятельствах.
    for (const call of db.model("contact").update.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("accessTokenId");
    }
    expect(rememberInviteLink).toHaveBeenCalledWith("c1", "https://t.me/+NEW-100500");
    expect(db.model("purchase").update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { inviteLink: "https://t.me/+NEW-100500" },
    });
  });

  it("ГЛАВНОЕ: кто уже вошёл в группу по этой покупке — нового приглашения не получает", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase({ joinedAt: new Date() })]);
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "in-group" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });

  it("уже вступала раньше, а покупка старее этого входа — не выдаём; новая покупка — выдаём", async () => {
    db.model("contact").findUnique.mockResolvedValue({
      ...baseContact,
      joinedGroupAt: new Date("2026-10-05T00:00:00Z"),
    });
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "in-group" });

    db.model("purchase").findMany.mockResolvedValue([
      purchase(),
      purchase({ id: "p2", course: "COURSE70", createdAt: new Date("2026-10-20T00:00:00Z") }),
    ]);
    const r = await issueOwnerLink("c1", "telegram");
    expect(r).toEqual({ ok: true, kind: "telegram", links: [{ course: "COURSE70", url: "https://t.me/+NEW-100700" }] });
  });

  it("Telegram говорит, что человек уже в группе — не выдаём (покупка не помечена)", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, telegramUserId: "777" });
    getChatMemberStatus.mockResolvedValue("member");
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "in-group" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });

  it("не смогли проверить, в группе ли человек — не выдаём наугад", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, telegramUserId: "777" });
    getChatMemberStatus.mockResolvedValue(null);
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "check-failed" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });

  it("прежнее неиспользованное приглашение гасим, чтобы его нельзя было переслать", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, telegramUserId: "777" });
    db.model("purchase").findMany.mockResolvedValue([purchase({ inviteLink: "https://t.me/+OLD" })]);
    await issueOwnerLink("c1", "telegram");
    expect(revokeInviteLink).toHaveBeenCalledWith("бот-токен", "-100500", "https://t.me/+OLD");
    // гасим только после того, как новое готово
    expect(createOneTimeInviteLink.mock.invocationCallOrder[0]).toBeLessThan(
      revokeInviteLink.mock.invocationCallOrder[0],
    );
  });

  it("Telegram человека неизвестен, а приглашение ей уже выдавали — не выдаём второе", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase({ inviteLink: "https://t.me/+OLD" })]);
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "unknown-member" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });

  it("вышла из группы (Telegram известен) — старые отметки входа не мешают позвать снова", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, telegramUserId: "777", joinedGroupAt: new Date() });
    db.model("purchase").findMany.mockResolvedValue([purchase({ joinedAt: new Date() })]);
    getChatMemberStatus.mockResolvedValue("left");
    const r = await issueOwnerLink("c1", "telegram");
    expect(r.ok).toBe(true);
  });

  it("забанена вручную (kicked) — приглашение не выдаём", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, telegramUserId: "777" });
    getChatMemberStatus.mockResolvedValue("kicked");
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "in-group" });
  });

  it("две выдачи одному человеку одновременно: вторая ждёт, приглашение одно", async () => {
    let release!: () => void;
    createOneTimeInviteLink.mockImplementationOnce(() => new Promise((res) => { release = () => res("https://t.me/+SLOW"); }));
    const first = issueOwnerLink("c1", "telegram");
    await new Promise((r) => setTimeout(r, 10));
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "busy" });
    release();
    expect((await first).ok).toBe(true);
    expect(createOneTimeInviteLink).toHaveBeenCalledTimes(1);
  });

  it("ссылка-сайт в Purchase.inviteLink не принимается за приглашение и не гасится", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase({ inviteLink: "https://shirinsweets.online/l/OLD" })]);
    await issueOwnerLink("c1", "telegram");
    expect(revokeInviteLink).not.toHaveBeenCalled();
  });

  it("группа курса не настроена или бот не подключён", async () => {
    delete SETTINGS.telegramChatId50;
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "no-group" });
    SETTINGS.telegramChatId50 = "-100500";
    delete SETTINGS.telegramBotToken;
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "no-bot" });
    SETTINGS.telegramBotToken = "бот-токен";
  });

  it("Telegram не дал ссылку — честная ошибка, база не меняется", async () => {
    createOneTimeInviteLink.mockResolvedValueOnce(null as never);
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "tg-failed" });
    expect(db.model("purchase").update).not.toHaveBeenCalled();
  });

  it("отобранный доступ — приглашения нет", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...baseContact, accessRevokedAt: new Date() });
    expect(await issueOwnerLink("c1", "telegram")).toEqual({ ok: false, reason: "blocked" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });
});

describe("Карточка владельца: одноразовая и со сроком", () => {
  it("первое нажатие работает, второе — нет", () => {
    const n = createOffer("c1");
    expect(takeOffer(n)).toBe("c1");
    expect(takeOffer(n)).toBeNull();
  });

  it("через срок карточка мертва, даже если её ещё не нажимали", () => {
    vi.useFakeTimers();
    try {
      const n = createOffer("c1");
      vi.advanceTimersByTime(OFFER_TTL_MS + 1000);
      expect(takeOffer(n)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("чужая или выдуманная метка ничего не открывает", () => {
    expect(takeOffer("deadbeef0000")).toBeNull();
    expect(takeOffer("")).toBeNull();
  });
});

describe("Поиск человека", () => {
  it("слишком короткий запрос не ищет ничего", async () => {
    expect(await findPeople("a")).toEqual([]);
    expect(db.model("contact").findMany).not.toHaveBeenCalled();
  });

  it("ищет только среди тех, у кого есть действующая покупка и нет блокировки", async () => {
    db.model("contact").findMany.mockResolvedValue([{ ...baseContact, purchases: [{ course: "COURSE50" }] }]);
    const people = await findPeople("@Malika");
    expect(people).toEqual([{ id: "c1", handle: "@malika", name: "Малика", courses: ["COURSE50"] }]);
    const where = db.model("contact").findMany.mock.calls[0][0].where;
    const text = JSON.stringify(where);
    expect(text).toContain('"revokedAt":null');
    expect(text).toContain('"accessRevokedAt":null');
    expect(text).toContain('"spamBlockedAt":null');
    expect(text).toContain("malika");
  });
});
