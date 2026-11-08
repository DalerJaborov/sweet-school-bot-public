import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => undefined);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a) }));

import { issueMagicLink, verifyMagicLink, openByLink, currentAccess, statusFor, phoneLabel, devicePhoneMessage } from "../../src/course/access.js";
import { courseTokenSecret } from "../../src/course/tokenSecret.js";
import { env } from "../../src/env.js";

type Headers = Record<string, string | undefined>;

function fakeReq(headers: Headers = {}) {
  return {
    headers: { cookie: headers.cookie },
    header: (name: string) => headers[name.toLowerCase()],
    ip: "10.0.0.1",
  } as never;
}

function fakeRes() {
  const stored: Record<string, string[]> = {};
  return {
    setHeader: (k: string, v: string | string[]) => {
      stored[k] = Array.isArray(v) ? v : [v];
    },
    cookies: stored,
  } as never as { setHeader: (k: string, v: string | string[]) => void; cookies: Record<string, string[]> };
}

/**
 * ССЫЛКА И СЕССИЯ ПРИНАДЛЕЖАТ ЧЕЛОВЕКУ (03.09.2026). Раньше — покупке: купившая
 * оба курса получала две ссылки и два окна. Здесь всё строится от контакта.
 */
const contact = {
  id: "contact-1",
  igUserId: "ig-1",
  username: "client",
  accessTokenId: null as string | null,
  studentFirstName: null,
  studentLastName: null,
  preferredLanguage: null,
};

const purchase = {
  id: "purchase-1",
  contactId: "contact-1",
  courseId: "course-1",
  accessTokenId: null as string | null,
  revokedAt: null as Date | null,
  firstOpenedAt: null as Date | null,
  startedLearning: false,
};

const purchase2 = { ...purchase, id: "purchase-2", courseId: "course-2" };

/**
 * Обычная готовая обстановка: человек с одной действующей покупкой.
 *
 * Ссылка теперь короткий код в базе (Contact.accessTokenId), а не JWT: контакт
 * находится по коду. Мок отдаёт контакт с тем кодом, по которому спросили,
 * если тест не задал другой явно — тогда чужой код не найдёт никого.
 */
function arrange(db: PrismaMock, over: { contact?: Partial<typeof contact>; purchases?: unknown[]; limit?: number } = {}) {
  db.model("contact").findUnique.mockImplementation(async ({ where }: { where: { id?: string; accessTokenId?: string } }) => {
    const fixed = over.contact?.accessTokenId;
    if (where.accessTokenId && fixed && fixed !== where.accessTokenId) return null;
    return {
      ...contact,
      accessIssuedAt: new Date(),
      ...(over.contact ?? {}),
      accessTokenId: fixed ?? where.accessTokenId ?? contact.accessTokenId,
    };
  });
  db.model("purchase").findMany.mockResolvedValue(over.purchases ?? [{ ...purchase }]);
  db.model("course").findMany.mockResolvedValue([{ id: "course-1", deviceLimit: over.limit ?? 3 }]);
  db.model("device").findFirst.mockResolvedValue(null);
  db.model("device").count.mockResolvedValue(0);
  db.model("device").findMany.mockResolvedValue([]);
  db.model("purchase").updateMany.mockResolvedValue({ count: 1 });
}

describe("magic link", () => {
  it("выданная ссылка — КОРОТКАЯ: код из десяти знаков в пути, а не JWT в адресе", () => {
    const { url, jti, token } = issueMagicLink("contact-1");

    expect(url).toMatch(/\/l\/[A-Za-z0-9]{10}$/);
    expect(token).toBe(jti);
    expect(token).not.toMatch(/[0O1lI]/); // буквы, которые путают, диктуя по телефону
    const claims = verifyMagicLink(token);
    expect(claims).toMatchObject({ kind: "course-link", jti });
    expect(claims?.contactId).toBeUndefined();
  });

  it("чужая подпись и мусор отвергаются", () => {
    const alien = jwt.sign({ kind: "course-link", contactId: "c", jti: "j" }, "another-secret");
    expect(verifyMagicLink(alien)).toBeNull();
    expect(verifyMagicLink("не-токен")).toBeNull();
  });

  it("истёкшая ссылка не пускает", () => {
    const expired = jwt.sign({ kind: "course-link", contactId: "c", jti: "j" }, courseTokenSecret(), { expiresIn: "-1h" });
    expect(verifyMagicLink(expired)).toBeNull();
  });

  it("токен сессии не принимается как ссылка входа", () => {
    const session = jwt.sign({ kind: "course-session", contactId: "c", deviceId: "d" }, courseTokenSecret());
    expect(verifyMagicLink(session)).toBeNull();
  });

  it("НАСЛЕДИЕ: ссылка с purchaseId, выданная до правки, всё ещё распознаётся", () => {
    const old = jwt.sign({ kind: "course-link", purchaseId: "purchase-1", jti: "старый" }, env.jwtSecret);
    expect(verifyMagicLink(old)).toMatchObject({ purchaseId: "purchase-1", jti: "старый" });
  });
});

describe("openByLink", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    sendTelegramMessage.mockClear();
  });
  afterEach(restorePrisma);

  it("первое открытие: устройство создаётся с СЕРВЕРНОЙ меткой и принадлежит человеку, ставятся обе куки", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").create.mockImplementation(async ({ data }: { data: { secret: string; contactId: string } }) => ({
      id: "device-1",
      blockedAt: null,
      secret: data.secret,
      contactId: data.contactId,
    }));

    const res = fakeRes();
    const result = await openByLink(fakeReq({ "user-agent": "Android" }), res as never, token, "hint");

    expect(result.ok).toBe(true);
    const cookies = res.cookies["Set-Cookie"];
    expect(cookies.some((c) => c.startsWith("ssb_course="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("ssb_device="))).toBe(true);
    expect(cookies.every((c) => c.includes("HttpOnly"))).toBe(true);
    // Метку придумывает сервер, а не принимает от клиента; устройство — человека.
    const created = db.model("device").create.mock.calls[0][0] as { data: { secret: string; contactId: string } };
    expect(created.data.secret).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.data.contactId).toBe("contact-1");
    // Первое открытие отмечается на ВСЕХ действующих покупках разом.
    expect(db.model("purchase").updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: "contact-1", revokedAt: null, firstOpenedAt: null },
        data: { firstOpenedAt: expect.any(Date) },
      })
    );
  });

  it("ГЛАВНОЕ: два курса — одна ссылка, оба в сессии", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { purchases: [{ ...purchase }, { ...purchase2 }] });
    db.model("device").create.mockResolvedValue({ id: "device-1", blockedAt: null, secret: "s", contactId: "contact-1" });

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.purchases.map((p) => p.id)).toEqual(["purchase-1", "purchase-2"]);
      expect(result.purchase.id).toBe("purchase-1"); // якорная — самая ранняя
    }
  });

  it("лимит — ОДИН телефон: столбец Course.deviceLimit больше не читается", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { purchases: [{ ...purchase }, { ...purchase2 }] });
    db.model("course").findMany.mockResolvedValue([
      { id: "course-1", deviceLimit: 2 },
      { id: "course-2", deviceLimit: 4 },
    ]);
    db.model("device").count.mockResolvedValue(1);

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
  });

  it("подделанный отпечаток НЕ выдаёт себя за знакомое устройство", async () => {
    // Раньше десять подруг с одним присланным отпечатком считались одним
    // устройством: лимит не тратился, тревоги не было. Теперь без нашей куки
    // это всегда новое устройство.
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(1); // единственное место занято

    const result = await openByLink(fakeReq(), fakeRes() as never, token, "чужой-отпечаток-подруги");

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("заблокированные устройства ЗАНИМАЮТ место — считаем все устройства человека", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(1);

    await openByLink(fakeReq(), fakeRes() as never, token);

    // Без фильтра по blockedAt и по контакту, а не по покупке.
    expect(db.model("device").count).toHaveBeenCalledWith({ where: { contactId: "contact-1" } });
  });

  it("все покупки отозваны — не пускает и устройство не создаёт", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { purchases: [] });

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "revoked" });
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("старая ссылка после перевыдачи не оживает", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessTokenId: "другой-jti" } }); // в базе уже другой код

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("лишнее устройство при исчерпанном лимите — стоп с понятным текстом", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(1);

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect((result as { message: string }).message).toContain("другом телефоне");
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("узнаём по НАШЕЙ метке из куки и продлеваем офлайн-ключ на 30 дней", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").findFirst.mockResolvedValue({
      id: "device-1",
      blockedAt: null,
      secret: "метка-устройства",
      lastCity: "TJ",
      lastSeenAt: new Date(),
    });
    db.model("device").update.mockResolvedValue({ id: "device-1", blockedAt: null, secret: "метка-устройства" });

    const result = await openByLink(
      fakeReq({ "cf-ipcountry": "TJ", cookie: "ssb_device=метка-устройства" }),
      fakeRes() as never,
      token
    );

    expect(result.ok).toBe(true);
    // Ищем метку среди устройств ЧЕЛОВЕКА.
    expect(db.model("device").findFirst).toHaveBeenCalledWith({
      where: { contactId: "contact-1", secret: "метка-устройства" },
    });
    const call = db.model("device").update.mock.calls[0][0] as { data: { offlineKeyExpiresAt: Date } };
    const days = (call.data.offlineKeyExpiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("заблокированное устройство не пускают", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").findFirst.mockResolvedValue({
      id: "device-1",
      secret: "метка",
      blockedAt: new Date(),
      blockedReason: "Ссылку передали",
    });

    const result = await openByLink(fakeReq({ cookie: "ssb_device=метка" }), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "blocked", message: "Ссылку передали" });
  });

  it("вход из другой страны в течение часа — тревога владельцу, но доступ не рубим", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").findFirst.mockResolvedValue({
      id: "device-1",
      secret: "метка",
      blockedAt: null,
      lastCity: "TJ",
      lastSeenAt: new Date(Date.now() - 10 * 60_000),
    });
    db.model("device").update.mockResolvedValue({ id: "device-1", blockedAt: null, secret: "метка" });
    // Настройки Telegram заданы — иначе тревога молча пропускается.
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => ({
      value: where.key === "telegramBotToken" ? "bot-token" : "owner-chat",
    }));

    const result = await openByLink(
      fakeReq({ "cf-ipcountry": "RU", cookie: "ssb_device=метка" }),
      fakeRes() as never,
      token
    );

    expect(result.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("@client");
  });

  it("НАСЛЕДИЕ: старая ссылка с purchaseId открывает уроки — по покупке находим человека", async () => {
    // Ссылки, разосланные до правки, живут 7 дней: выкинуть их значило бы
    // выгнать учениц посреди урока. jti при этом сверяем там, где он хранился —
    // на покупке.
    const old = jwt.sign({ kind: "course-link", purchaseId: "purchase-1", jti: "старый" }, env.jwtSecret);
    arrange(db);
    db.model("purchase").findUnique.mockResolvedValue({ ...purchase, accessTokenId: "старый" });
    db.model("device").create.mockResolvedValue({ id: "device-1", blockedAt: null, secret: "s", contactId: "contact-1" });

    const result = await openByLink(fakeReq(), fakeRes() as never, old);

    expect(result.ok).toBe(true);
    expect(db.model("contact").findUnique).toHaveBeenCalledWith({ where: { id: "contact-1" } });
  });

  it("код старше семи дней не пускает — как и JWT со сроком", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessIssuedAt: new Date(Date.now() - 8 * 86_400_000) } });

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("currentAccess", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  function session(claims: Record<string, unknown> = { contactId: "contact-1", deviceId: "device-1" }) {
    return jwt.sign({ kind: "course-session", ...claims }, courseTokenSecret());
  }

  it("без куки — просьба открыть ссылку, а не пустая ошибка", async () => {
    const result = await currentAccess(fakeReq());
    expect(result).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("кука с чужой подписью не проходит", async () => {
    const alien = jwt.sign({ kind: "course-session", contactId: "c", deviceId: "d" }, "another");
    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${alien}` }));
    expect(result).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("давно не виденное устройство: офлайн-ключ продлевается", async () => {
    arrange(db);
    db.model("device").findUnique.mockResolvedValue({
      id: "device-1",
      contactId: "contact-1",
      blockedAt: null,
      lastSeenAt: new Date(Date.now() - 60 * 60_000),
    });
    db.model("device").update.mockResolvedValue({ id: "device-1", blockedAt: null });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${session()}` }));

    expect(result.ok).toBe(true);
    expect(db.model("device").update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ offlineKeyExpiresAt: expect.any(Date) }) })
    );
  });

  it("свежее устройство НЕ пишется в базу на каждый запрос", async () => {
    // Плеер дёргает манифест, ключ и прогресс десятки раз за урок. Запись на
    // каждый запрос конкурировала бы с ботом за единственного писателя SQLite.
    arrange(db);
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null, lastSeenAt: new Date() });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${session()}` }));

    expect(result.ok).toBe(true);
    expect(db.model("device").update).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: докупленный курс появляется в той же сессии без новой ссылки", async () => {
    arrange(db, { purchases: [{ ...purchase }, { ...purchase2 }] });
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null, lastSeenAt: new Date() });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${session()}` }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purchases).toHaveLength(2);
  });

  it("все покупки отозвали — старая кука перестаёт работать", async () => {
    arrange(db, { purchases: [] });
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${session()}` }));

    expect(result).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("устройство другого человека с этой сессией — не наш случай", async () => {
    arrange(db);
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-2", blockedAt: null });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${session()}` }));

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("НАСЛЕДИЕ: сессия с purchaseId, выданная до правки, продолжает работать", async () => {
    const old = jwt.sign({ kind: "course-session", purchaseId: "purchase-1", deviceId: "device-1" }, env.jwtSecret);
    arrange(db);
    db.model("purchase").findUnique.mockResolvedValue({ ...purchase });
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: null, blockedAt: null, lastSeenAt: new Date() });

    const result = await currentAccess(fakeReq({ cookie: `ssb_course=${old}` }));

    expect(result.ok).toBe(true);
  });
});

describe("statusFor", () => {
  it("разные причины — разные коды, чтобы фронт показал нужный экран", () => {
    expect(statusFor("no_session")).toBe(401);
    expect(statusFor("device_limit")).toBe(429);
    expect(statusFor("revoked")).toBe(403);
    expect(statusFor("blocked")).toBe(403);
    expect(statusFor("not_found")).toBe(404);
  });
});


describe("политика «один телефон»", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    sendTelegramMessage.mockClear();
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "telegramBotToken" ? { value: "token" } : null
    );
  });
  afterEach(restorePrisma);

  const ANDROID_A = "Mozilla/5.0 (Linux; Android 13; SM-A546B Build/TP1A) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
  const ANDROID_B = "Mozilla/5.0 (Linux; Android 12; Pixel 7 Build/SQ3A) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
  const ANDROID_REDUCED = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  function occupied(over: Record<string, unknown>) {
    return {
      id: "device-old",
      contactId: "contact-1",
      blockedAt: null,
      secret: "s-old",
      lastCity: "TJ",
      lastIp: "10.0.0.1",
      lastSeenAt: new Date(Date.now() - 2 * 86_400_000),
      userAgent: ANDROID_A,
      ...over,
    };
  }

  async function open(ua: string, existing: unknown[]) {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(existing.length);
    db.model("device").findMany.mockResolvedValue(existing);
    db.model("device").update.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, blockedAt: null, secret: "s-old" }));
    db.model("device").create.mockResolvedValue({ id: "device-new", blockedAt: null, secret: "s-new" });
    return openByLink(fakeReq({ "user-agent": ua, "x-forwarded-for": "10.0.0.1" }), fakeRes() as never, token, undefined);
  }

  it("другая ОС — это другой телефон: стоп, владелец не тревожится", async () => {
    const result = await open(IPHONE, [occupied({ lastSeenAt: new Date() })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("два Android с разными известными моделями — разные телефоны", async () => {
    const result = await open(ANDROID_B, [occupied({ lastSeenAt: new Date() })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
  });

  it("Instagram → Chrome на том же Android: та же модель и сеть — пускаем тихо, без тревоги", async () => {
    const result = await open(ANDROID_A.replace("Chrome/120", "Instagram 300 Chrome/120"), [occupied({})]);
    expect(result.ok).toBe(true);
    expect(db.model("device").create).not.toHaveBeenCalled();
    expect(db.model("device").update).toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("смена сети (Wi-Fi → мобильный): та же модель Android, другой адрес — пускаем, владельцу сводка", async () => {
    const result = await open(ANDROID_A, [occupied({ lastIp: "192.168.7.20" })]);
    expect(result.ok).toBe(true);
    expect(db.model("device").create).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("Возможно, второй телефон");
  });

  it("iPhone без модели: Instagram → Safari в той же сети недавно — пускаем, владельцу сводка (модель неизвестна)", async () => {
    const result = await open(IPHONE, [occupied({ userAgent: IPHONE.replace("Mobile/15E148", "Mobile/15E148 Instagram 300"), lastSeenAt: new Date(Date.now() - 20 * 60_000) })]);
    expect(result.ok).toBe(true);
    expect(db.model("device").create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("iPhone без модели в ДРУГОЙ сети и без совпавшего отпечатка — другой телефон: стоп", async () => {
    const result = await open(IPHONE, [occupied({ userAgent: IPHONE, lastIp: "172.16.9.9", lastSeenAt: new Date() })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
  });

  it("Android с урезанным User-Agent («K»), та же сеть, свежий заход — пускаем, владельцу сводка", async () => {
    const result = await open(ANDROID_REDUCED, [occupied({ userAgent: ANDROID_REDUCED, lastSeenAt: new Date(Date.now() - 5 * 60_000) })]);
    expect(result.ok).toBe(true);
    expect(db.model("device").create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("модель скрыта, сеть та же, но прошлый заход давно — другой телефон: стоп", async () => {
    const result = await open(ANDROID_REDUCED, [occupied({ userAgent: ANDROID_REDUCED })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
  });

  it("компьютер при занятом телефоне — стоп", async () => {
    const result = await open(WINDOWS, [occupied({ lastSeenAt: new Date() })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
  });

  it("второй телефон: отказ с понятным текстом «купите курс для него», ничего не удаляется и не переносится", async () => {
    const result = await open(IPHONE, [occupied({ lastSeenAt: new Date() })]);
    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect((result as { message: string }).message).toMatch(/Этот курс открывается на/);
    expect((result as { message: string }).message).toMatch(/купите курс для него/);
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(db.model("contact").update).not.toHaveBeenCalled();
  });

  it("phoneLabel: модель Android, iPhone, неизвестная модель — null", () => {
    expect(phoneLabel(IPHONE)).toBe("iPhone");
    expect(phoneLabel(ANDROID_A)).toMatch(/^[A-Za-z0-9 -]{3,}$/);
    expect(phoneLabel(ANDROID_REDUCED)).toBeNull();
    expect(phoneLabel(WINDOWS)).toBeNull();
    expect(phoneLabel(null)).toBeNull();
    expect(devicePhoneMessage(null)).toBe("Этот курс открывается на вашем основном телефоне. Чтобы смотреть на другом телефоне, купите курс для него");
    expect(devicePhoneMessage("iPhone")).toContain("на телефоне iPhone.");
  });
});
