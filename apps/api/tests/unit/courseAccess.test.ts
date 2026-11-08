import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mockPrisma, restorePrisma, type PrismaMock } from "../helpers.js";

const sendTelegramMessage = vi.fn(async () => undefined);
vi.mock("../../src/telegram.js", () => ({
  techChatIds: vi.fn(async () => ["owner-1"]), sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a) }));

import {
  issueMagicLink,
  verifyMagicLink,
  openByLink,
  currentAccess,
  statusFor,
  ownerOfExpiredLink,
  deviceFingerprint,
  SAME_PHONE_WINDOW_MS,
} from "../../src/course/access.js";
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

  it("лимит устройств — самый щедрый из купленных курсов", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { purchases: [{ ...purchase }, { ...purchase2 }] });
    db.model("course").findMany.mockResolvedValue([
      { id: "course-1", deviceLimit: 2 },
      { id: "course-2", deviceLimit: 4 },
    ]);
    db.model("device").count.mockResolvedValue(3);
    db.model("device").create.mockResolvedValue({ id: "device-1", blockedAt: null, secret: "s", contactId: "contact-1" });

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result.ok).toBe(true); // 3 < 4
  });

  it("подделанный отпечаток НЕ выдаёт себя за знакомое устройство", async () => {
    // Раньше десять подруг с одним присланным отпечатком считались одним
    // устройством: лимит не тратился, тревоги не было. Теперь без нашей куки
    // это всегда новое устройство.
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(3); // места уже заняты

    const result = await openByLink(fakeReq(), fakeRes() as never, token, "чужой-отпечаток-подруги");

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("заблокированные устройства ЗАНИМАЮТ место — считаем все устройства человека", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db);
    db.model("device").count.mockResolvedValue(3);

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
    arrange(db, { limit: 2 });
    db.model("device").count.mockResolvedValue(2);

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect((result as { message: string }).message).toContain("2 устройствах");
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

  it("код старше семи дней сам не пускает — без сессии это link_expired (410), а не тупик", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessIssuedAt: new Date(Date.now() - 8 * 86_400_000) } });

    const result = await openByLink(fakeReq(), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "link_expired" });
    expect(statusFor("link_expired")).toBe(410);
    expect(db.model("device").create).not.toHaveBeenCalled();
  });
});

/**
 * СТАРАЯ ССЫЛКА ПРИ ЖИВОЙ СЕССИИ (аудит 08.11.2026): ссылка живёт неделю,
 * браузер помнит вход год. Повторное нажатие ссылки из директа открывает
 * кабинет, если в этом браузере уже есть вход.
 */
describe("openByLink: просроченная или заменённая ссылка + живая сессия", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  const liveSession = () =>
    `ssb_course=${jwt.sign({ kind: "course-session", contactId: "contact-1", deviceId: "device-1" }, courseTokenSecret())}`;

  it("ГЛАВНОЕ: код старше недели, сессия жива — сразу кабинет, без новой куки и без нового устройства", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessIssuedAt: new Date(Date.now() - 30 * 86_400_000) } });
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null, lastSeenAt: new Date() });
    const res = fakeRes();

    const result = await openByLink(fakeReq({ cookie: liveSession() }), res as never, token);

    expect(result.ok).toBe(true);
    expect(res.cookies["Set-Cookie"]).toBeUndefined();
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("ссылку перевыдали (код заменён), сессия жива — тоже кабинет", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessTokenId: "другой-код" } });
    db.model("contact").findUnique.mockImplementation(async ({ where }: { where: { id?: string; accessTokenId?: string } }) =>
      where.accessTokenId ? null : { ...contact, id: "contact-1", accessIssuedAt: new Date() }
    );
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null, lastSeenAt: new Date() });

    const result = await openByLink(fakeReq({ cookie: liveSession() }), fakeRes() as never, token);

    expect(result.ok).toBe(true);
  });

  it("сессия есть, но доступ отозван — честное «закрыто», а не «ссылка устарела»", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessIssuedAt: new Date(Date.now() - 30 * 86_400_000) }, purchases: [] });
    db.model("device").findUnique.mockResolvedValue({ id: "device-1", contactId: "contact-1", blockedAt: null, lastSeenAt: new Date() });

    const result = await openByLink(fakeReq({ cookie: liveSession() }), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("сессия испорчена или устройство освобождено — остаётся link_expired с кнопкой «получить новую»", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { contact: { accessIssuedAt: new Date(Date.now() - 30 * 86_400_000) } });
    db.model("device").findUnique.mockResolvedValue(null);

    const result = await openByLink(fakeReq({ cookie: liveSession() }), fakeRes() as never, token);

    expect(result).toMatchObject({ ok: false, reason: "link_expired" });
  });
});

describe("ownerOfExpiredLink — кому слать новую ссылку", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  it("находит человека только по ПРОСРОЧЕННОМУ и всё ещё последнему коду", async () => {
    const { token } = issueMagicLink("contact-1");
    db.model("contact").findUnique.mockResolvedValue({ ...contact, accessTokenId: token, accessIssuedAt: new Date(Date.now() - 8 * 86_400_000) });
    expect((await ownerOfExpiredLink(token))?.id).toBe("contact-1");

    // Действующая ссылка — не повод перевыдавать: её просто открывают.
    db.model("contact").findUnique.mockResolvedValue({ ...contact, accessTokenId: token, accessIssuedAt: new Date() });
    expect(await ownerOfExpiredLink(token)).toBeNull();

    // Код уже заменён новым — никого.
    db.model("contact").findUnique.mockResolvedValue(null);
    expect(await ownerOfExpiredLink(token)).toBeNull();
    // Мусор и старые JWT в базу даже не идут.
    expect(await ownerOfExpiredLink("не-код")).toBeNull();
  });
});

/**
 * ДЫРА С ОДИНАКОВЫМИ ТЕЛЕФОНАМИ (аудит 08.11.2026): по модели/экрану/поясу
 * узнаём «тот же телефон» только если прежнее устройство было в сети последние
 * 30 минут (переход из Instagram в Safari). Иначе — новое устройство и лимит.
 */
describe("registerDevice: запасной путь по модели — только в окне 30 минут", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
  });
  afterEach(restorePrisma);

  /** Поиск устройства, честно исполняющий фильтр lastSeenAt.gte из запроса. */
  function devicesInDb(devices: { id: string; fingerprint: string; lastSeenAt: Date; secret: string }[]) {
    db.model("device").findFirst.mockImplementation(
      async ({ where }: { where: { secret?: string; fingerprint?: string; lastSeenAt?: { gte: Date } } }) => {
        const hit = devices.find(
          (d) =>
            (where.secret ? d.secret === where.secret : true) &&
            (where.fingerprint ? d.fingerprint === where.fingerprint : true) &&
            (where.lastSeenAt ? d.lastSeenAt >= where.lastSeenAt.gte : true)
        );
        return hit ? { ...hit, contactId: "contact-1", blockedAt: null, lastCity: null, userAgent: null } : null;
      }
    );
    db.model("device").update.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, blockedAt: null, secret: "s" }));
    db.model("device").create.mockImplementation(async () => ({ id: "new-device", blockedAt: null, secret: "new", contactId: "contact-1" }));
  }

  const HINT = "1170x2532|3|Asia/Dushanbe|6";

  it("переход из встроенного браузера через 5 минут — то же устройство, место не тратится", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { limit: 2 });
    db.model("device").count.mockResolvedValue(2);
    const fp = deviceFingerprint(fakeReq({ "user-agent": "iPhone" }), HINT);
    devicesInDb([{ id: "device-1", fingerprint: fp, lastSeenAt: new Date(Date.now() - 5 * 60_000), secret: "s1" }]);

    const result = await openByLink(fakeReq({ "user-agent": "iPhone" }), fakeRes() as never, token, HINT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.device.id).toBe("device-1");
    expect(db.model("device").create).not.toHaveBeenCalled();
  });

  it("ГЛАВНОЕ: подруга с таким же iPhone через день — НЕ то же устройство, лимит срабатывает", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { limit: 2 });
    db.model("device").count.mockResolvedValue(2);
    const fp = deviceFingerprint(fakeReq({ "user-agent": "iPhone" }), HINT);
    devicesInDb([{ id: "device-1", fingerprint: fp, lastSeenAt: new Date(Date.now() - 26 * 3_600_000), secret: "s1" }]);

    const result = await openByLink(fakeReq({ "user-agent": "iPhone" }), fakeRes() as never, token, HINT);

    expect(result).toMatchObject({ ok: false, reason: "device_limit" });
    expect(db.model("device").update).not.toHaveBeenCalled();
    const query = db.model("device").findFirst.mock.calls[0][0] as { where: { lastSeenAt: { gte: Date } } };
    const windowMin = (Date.now() - query.where.lastSeenAt.gte.getTime()) / 60_000;
    expect(windowMin).toBeGreaterThan(29);
    expect(windowMin).toBeLessThanOrEqual(30.1);
    expect(SAME_PHONE_WINDOW_MS).toBe(30 * 60_000);
  });

  it("свободное место есть — тот же отпечаток через час становится вторым устройством (без ошибки уникальности)", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { limit: 2 });
    db.model("device").count.mockResolvedValue(1);
    const fp = deviceFingerprint(fakeReq({ "user-agent": "iPhone" }), HINT);
    devicesInDb([{ id: "device-1", fingerprint: fp, lastSeenAt: new Date(Date.now() - 60 * 60_000), secret: "s1" }]);

    const result = await openByLink(fakeReq({ "user-agent": "iPhone" }), fakeRes() as never, token, HINT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.device.id).toBe("new-device");
  });

  it("своя ученица с новым телефоном не заперта: замена самой (2 в месяц) работает и пишет журнал", async () => {
    const { token } = issueMagicLink("contact-1");
    arrange(db, { limit: 2 });
    let used = 2;
    db.model("device").count.mockImplementation(async () => used);
    devicesInDb([{ id: "device-1", fingerprint: "другой", lastSeenAt: new Date(Date.now() - 40 * 86_400_000), secret: "s1" }]);
    db.model("device").delete.mockImplementation(async () => {
      used = 1;
      return { id: "device-1" };
    });

    const result = await openByLink(fakeReq({ "user-agent": "iPhone" }), fakeRes() as never, token, HINT, true);

    expect(result.ok).toBe(true);
    expect(db.model("accessEvent").create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contactId: "contact-1", deviceId: "device-1", action: "released", actor: "student" }),
    });
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
