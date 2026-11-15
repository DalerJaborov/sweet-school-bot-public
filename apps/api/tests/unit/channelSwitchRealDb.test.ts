import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { PrismaClient, type Contact } from "@prisma/client";
import { prisma as originalPrisma, setPrismaClient } from "../../src/db.js";

/**
 * PR 64 v2 — ОДНА ДЕЙСТВУЮЩАЯ ССЫЛКА НА ЧЕЛОВЕКА, НА НАСТОЯЩЕЙ SQLITE.
 *
 * По одному тесту на каждый блокер ревью architect (08.11.2026) и на дыру из
 * #78. Схема накатывается во временный файл (как receiptRealDb.test.ts), заглушены
 * только отправка клиенту и Telegram Bot API: условия запросов проверяет сама база.
 */
const sendToContact = vi.fn(async (..._a: unknown[]) => "mid-1" as string | null);
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: (...a: unknown[]) => sendToContact(...a) }));

const createOneTimeInviteLink = vi.fn(async (..._a: unknown[]) => "https://t.me/+NEW" as string | null);
const revokeInviteLink = vi.fn(async (..._a: unknown[]) => true);
const getChatMemberStatus = vi.fn(async (..._a: unknown[]) => "left" as string | null);
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../src/telegram.js", async (orig) => ({
  ...(await orig<typeof import("../../src/telegram.js")>()),
  chatsForKind: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
  createOneTimeInviteLink: (...a: unknown[]) => createOneTimeInviteLink(...a),
  revokeInviteLink: (...a: unknown[]) => revokeInviteLink(...a),
  getChatMemberStatus: (...a: unknown[]) => getChatMemberStatus(...a),
}));
const platformReady = vi.fn(async (_c: string) => true);
vi.mock("../../src/course/delivery.js", async (orig) => ({
  ...(await orig<typeof import("../../src/course/delivery.js")>()),
  coursePlatformReady: (c: string) => platformReady(c),
}));

import {
  approveSwitchByOwner,
  askOwner,
  handleSwitchRequest,
  resetSwitchApprovals,
  switchCourseChannel,
} from "../../src/course/channelSwitch.js";
import { issueOwnerLink } from "../../src/course/ownerLink.js";
import { issueCourseLink } from "../../src/course/delivery.js";
import { withPersonLock } from "../../src/course/groupInvite.js";
import { deliveredCoursesSince } from "../../src/course/handedOut.js";
import { handleChatMember } from "../../src/groupAccess.js";
import { removeContactFromGroups } from "../../src/groupExit.js";
import { signAdminToken } from "../../src/adminLogin.js";
import { adminRouter } from "../../src/admin.js";

vi.setConfig({ testTimeout: 60_000 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switch-real-"));
const dbFile = path.join(dir, "test.db").replace(/\\/g, "/");
let db: PrismaClient;
const DAY = 86_400_000;
const CHAT50 = "-1001";
const CHAT70 = "-1002";
const OLD_INVITE = "https://t.me/+OLDINVITE";

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "ignore",
  });
  db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
  setPrismaClient(db);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
  setPrismaClient(originalPrisma);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Telegram Bot API для groupExit.ts (getChatMember/бан/разбан идут прямым fetch). */
function stubBotApi(status = "member") {
  const fetchMock = vi.fn(async (url: unknown) => {
    const method = String(url).split("/").pop() ?? "";
    const reply = method === "getChatMember" ? { ok: true, result: { status } } : { ok: true, result: true };
    return { json: async () => reply };
  });
  vi.stubGlobal("fetch", fetchMock);
  return (method: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));
}

beforeEach(async () => {
  sendToContact.mockReset().mockResolvedValue("mid-1");
  createOneTimeInviteLink.mockReset().mockResolvedValue("https://t.me/+NEW");
  revokeInviteLink.mockReset().mockResolvedValue(true);
  getChatMemberStatus.mockReset().mockResolvedValue("left");
  sendTelegramMessage.mockClear();
  platformReady.mockReset().mockResolvedValue(true);
  await resetSwitchApprovals();
  for (const t of ["accessEvent", "device", "receiptCheck", "purchase", "message", "contact", "setting"] as const) {
    await (db[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
  }
  await db.setting.createMany({
    data: [
      { key: "telegramBotToken", value: "tok" },
      { key: "telegramChatId50", value: CHAT50 },
      { key: "telegramChatId70", value: CHAT70 },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function person(over: Partial<Contact> = {}): Promise<Contact> {
  return db.contact.create({
    data: {
      id: "c-1",
      igUserId: "ig-1",
      username: "gulnora",
      channel: "INSTAGRAM",
      preferredLanguage: "ru",
      accessTokenId: "Ab3kQ9xZpm",
      accessIssuedAt: new Date(Date.now() - 2 * DAY),
      ...over,
    },
  });
}

async function bought(course: "COURSE50" | "COURSE70", over: Record<string, unknown> = {}) {
  return db.purchase.create({
    data: {
      contactId: "c-1",
      course,
      amount: 50,
      createdAt: new Date(Date.now() - 10 * DAY),
      firstOpenedAt: new Date(Date.now() - 9 * DAY),
      ...over,
    },
  });
}

const sentText = () => sendToContact.mock.calls.map((c) => String(c[1])).join("\n---\n");

describe("БЛОКЕР 1: приглашение тому, кто уже в группе, не выдаётся", () => {
  it("учится на сайте, но в группе ещё состоит: перевод в Telegram без нового приглашения, сайт закрыт", async () => {
    await person({ courseDeliveryChoice: "web", telegramUserId: "777", joinedGroupAt: new Date(Date.now() - 8 * DAY) });
    const p = await bought("COURSE50", { inviteLink: "http://localhost:4100/l/Ab3kQ9xZpm", firstOpenedAt: null });
    getChatMemberStatus.mockResolvedValue("member");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await switchCourseChannel(c, "telegram", "owner")).toBe("switched");

    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect(sentText()).toContain("Вы уже в группе с уроками");
    expect(sentText()).not.toContain("t.me/");
    const after = (await db.contact.findUnique({ where: { id: "c-1" } }))!;
    expect(after.courseDeliveryChoice).toBe("telegram");
    expect(after.accessIssuedAt?.getTime()).toBe(0); // сайтовая ссылка мертва
    // Покупка не получила новое приглашение; её прежняя запись не тронута.
    expect((await db.purchase.findUnique({ where: { id: p.id } }))!.inviteLink).toBe(p.inviteLink);
  });

  it("одна группа — уже в ней, вторая — нет: приглашение только во вторую", async () => {
    await person({ courseDeliveryChoice: "web", telegramUserId: "777" });
    await bought("COURSE50");
    const p70 = await bought("COURSE70");
    getChatMemberStatus.mockImplementation(async (_t, chatId) => (chatId === CHAT50 ? "member" : "left"));
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await switchCourseChannel(c, "telegram", "owner")).toBe("switched");

    expect(createOneTimeInviteLink).toHaveBeenCalledTimes(1);
    expect(createOneTimeInviteLink.mock.calls[0][1]).toBe(CHAT70);
    expect((await db.purchase.findUnique({ where: { id: p70.id } }))!.inviteLink).toBe("https://t.me/+NEW");
    expect(sentText()).toMatch(/уже есть/);
  });

  it("не смогли спросить Telegram — новое приглашение наугад не выдаём, сайт не трогаем, Ширин карточка", async () => {
    await person({ courseDeliveryChoice: "web", telegramUserId: "777" });
    await bought("COURSE50", { createdAt: new Date() });
    getChatMemberStatus.mockResolvedValue(null);
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await handleSwitchRequest(c, "telegram", "ru")).toBe("unverifiable");

    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.accessTokenId).toBe("Ab3kQ9xZpm");
    expect(JSON.stringify(sendTelegramMessage.mock.calls)).toContain("проверить, есть ли она уже в группе");
  });

  it("в группе она забанена (kicked) — не «вы уже в группе», а владельцу без кнопки", async () => {
    await person({ courseDeliveryChoice: "web", telegramUserId: "777" });
    await bought("COURSE50", { createdAt: new Date() });
    getChatMemberStatus.mockResolvedValue("kicked");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await handleSwitchRequest(c, "telegram", "ru")).toBe("banned");
    expect(sentText()).not.toContain("уже в группе");
    expect(JSON.stringify(sendTelegramMessage.mock.calls)).not.toContain("mn:sw");
  });

  it("та же проверка у «Выдать ссылку → Telegram» (одна дверь): член группы получает отказ", async () => {
    await person({ telegramUserId: "777" });
    await bought("COURSE50");
    getChatMemberStatus.mockResolvedValue("member");
    expect(await issueOwnerLink("c-1", "telegram")).toEqual({ ok: false, reason: "in-group" });
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });
});

describe("БЛОКЕР 3: карточка владельца «Перевести» одноразовая и со сроком", () => {
  async function setup() {
    await person({
      courseDeliveryChoice: "telegram",
      inviteLink: OLD_INVITE,
      accessTokenId: null,
      accessIssuedAt: null,
    });
    await bought("COURSE50", { inviteLink: OLD_INVITE });
    stubBotApi("left");
    return (await db.contact.findUnique({ where: { id: "c-1" } }))!;
  }

  it("без карточки кнопка ничего не делает", async () => {
    await setup();
    expect(await approveSwitchByOwner("c-1", "web")).toBe("expired");
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("карточка ушла — первое нажатие переводит, второе уже «устарела»", async () => {
    const c = await setup();
    await askOwner(c, "web", "просит", true);
    expect(JSON.stringify(sendTelegramMessage.mock.calls[0])).toContain("mn:sw:c-1:w");

    expect(await approveSwitchByOwner("c-1", "web")).toBe("ok");
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.courseDeliveryChoice).toBe("web");
    sendToContact.mockClear();
    expect(await approveSwitchByOwner("c-1", "web")).toBe("expired");
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("через сутки карточка гаснет", async () => {
    const c = await setup();
    await askOwner(c, "web", "просит", true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + DAY + 60_000);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("expired");
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it("кнопка с другим направлением, чем в карточке, не срабатывает", async () => {
    const c = await setup();
    await askOwner(c, "telegram", "просит", true);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("expired");
  });

  it("ревью #95: разрешение карточки лежит в базе, а не в памяти процесса (переживает перезапуск api)", async () => {
    const c = await setup();
    await askOwner(c, "web", "просит", true);
    const rows = await db.setting.findMany({ where: { key: { startsWith: "switchApproval:" } } });
    expect(rows).toHaveLength(1);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("ok");
    expect(await db.setting.count({ where: { key: { startsWith: "switchApproval:" } } })).toBe(0);
  });

  it("ревью #95: повтор просьбы, пока карточка жива, — новой карточки нет, старая работает", async () => {
    const c = await setup();
    await askOwner(c, "web", "просит", true);
    await askOwner(c, "web", "просит снова", true);
    expect(sendTelegramMessage.mock.calls.filter((x) => JSON.stringify(x).includes("mn:sw"))).toHaveLength(1);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("ok");
  });

  it("ревью #95: карточка использована или истекла — повтор просьбы в те же 12 часов даёт НОВУЮ карточку", async () => {
    const c = await setup();
    await askOwner(c, "web", "просит", true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + DAY + 60_000); // старая истекла
    await askOwner(c, "web", "просит снова", true);
    expect(sendTelegramMessage.mock.calls.filter((x) => JSON.stringify(x).includes("mn:sw"))).toHaveLength(2);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("ok");
  });

  it("ревью #95: человек уже на этом способе — кнопка честно говорит «ничего не меняла»", async () => {
    await person({ courseDeliveryChoice: "web" });
    await bought("COURSE50");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;
    await askOwner(c, "web", "просит", true);
    expect(await approveSwitchByOwner("c-1", "web")).toBe("already");
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

describe("БЛОКЕР 4: общий выпуск ссылки не закрывает Telegram незаметно", () => {
  it("issueCourseLink (возврат доступа и др.) не отзывает приглашение и не меняет выбор человека", async () => {
    await person({ courseDeliveryChoice: "telegram", inviteLink: OLD_INVITE });
    await bought("COURSE50", { inviteLink: OLD_INVITE });

    const url = await issueCourseLink("c-1", { automatic: false });

    expect(url).toContain("/l/");
    expect(revokeInviteLink).not.toHaveBeenCalled();
    const after = (await db.contact.findUnique({ where: { id: "c-1" } }))!;
    expect(after.courseDeliveryChoice).toBe("telegram");
    expect(after.inviteLink).toBe(OLD_INVITE);
  });

  it("явная выдача сайта владельцем закрывает приглашение — и говорит об этом (closedInvite)", async () => {
    await person({ courseDeliveryChoice: "telegram", inviteLink: OLD_INVITE, telegramUserId: "777" });
    await bought("COURSE50", { inviteLink: OLD_INVITE, joinedAt: new Date() });
    const calls = stubBotApi("member");

    const r = await issueOwnerLink("c-1", "web");

    expect(r).toMatchObject({ ok: true, kind: "web", closedInvite: true });
    expect(revokeInviteLink).toHaveBeenCalledWith("tok", CHAT50, OLD_INVITE);
    // Из группы НЕ убираем: Ширин всего лишь выдала ссылку.
    expect(calls("banChatMember")).toHaveLength(0);
  });
});

describe("БЛОКЕР 5: бесплатность перевода учитывает вход в группу на контакте", () => {
  it("вход отмечен только на контакте (старая оплата / ссылка из панели): перевод не бесплатный, лимит", async () => {
    await person({
      courseDeliveryChoice: "telegram",
      inviteLink: OLD_INVITE,
      joinedGroupAt: new Date(Date.now() - 9 * DAY),
      deviceSwaps: 1,
      deviceSwapAt: new Date(Date.now() - 3 * DAY),
    });
    await bought("COURSE50", { inviteLink: OLD_INVITE, firstOpenedAt: null, joinedAt: null });
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await handleSwitchRequest(c, "web", "ru")).toBe("limit");
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.courseDeliveryChoice).toBe("telegram");
  });

  it("то же без входа в группу — ещё ничего не открывала, перевод бесплатный", async () => {
    await person({
      courseDeliveryChoice: "telegram",
      inviteLink: OLD_INVITE,
      deviceSwaps: 1,
      deviceSwapAt: new Date(Date.now() - 3 * DAY),
    });
    await bought("COURSE50", { inviteLink: OLD_INVITE, firstOpenedAt: null, joinedAt: null });
    stubBotApi("left");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await handleSwitchRequest(c, "web", "ru")).toBe("switched");
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.deviceSwaps).toBe(1); // счётчик не тронут
  });
});

describe("БЛОКЕР 6: пометка «в группе» верна и после удаления, и после повторного входа", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(adminRouter);
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function inGroupInPanel(): Promise<boolean> {
    // Свой fetch для панели: глобальный fetch в тесте заглушён под Telegram.
    const { request } = await import("node:http");
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        `${base}/admin/contacts`,
        { headers: { authorization: `Bearer ${signAdminToken()}` } },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const { rows } = JSON.parse(body) as { rows: { id: string; inGroup: boolean }[] };
    return rows.find((r) => r.id === "c-1")!.inGroup;
  }

  it("вошла → удалили → вошла снова по новому приглашению", async () => {
    await person({ inviteLink: OLD_INVITE });
    await bought("COURSE50", { inviteLink: OLD_INVITE });
    const join = (link: string) =>
      handleChatMember({
        invite_link: { invite_link: link },
        new_chat_member: { status: "member", user: { id: 777 } },
        chat: { id: Number(CHAT50) },
      });

    await join(OLD_INVITE);
    expect(await inGroupInPanel()).toBe(true);

    stubBotApi("member");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;
    const exit = await removeContactFromGroups(c, await db.purchase.findMany({ where: { contactId: "c-1" } }), "bot");
    expect(exit.results.map((r) => r.state)).toEqual(["removed"]);
    expect(await inGroupInPanel()).toBe(false);

    // Новое приглашение (например, перевод обратно в Telegram) — и она снова вошла.
    await db.purchase.updateMany({ where: { contactId: "c-1" }, data: { inviteLink: "https://t.me/+AGAIN" } });
    await db.contact.update({ where: { id: "c-1" }, data: { inviteLink: "https://t.me/+AGAIN" } });
    await join("https://t.me/+AGAIN");
    expect(await inGroupInPanel()).toBe(true);
  });

  it("при удалении её в группе уже не было (вышла сама) — пометка гаснет", async () => {
    await person({ telegramUserId: "777", joinedGroupAt: new Date(Date.now() - DAY) });
    await bought("COURSE50", { inviteLink: OLD_INVITE, joinedAt: new Date(Date.now() - DAY) });
    stubBotApi("left");
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    await removeContactFromGroups(c, await db.purchase.findMany({ where: { contactId: "c-1" } }), "bot");

    expect(await inGroupInPanel()).toBe(false);
  });
});

describe("ДЫРА ИЗ #78: выданная кнопкой ссылка на сайт помечена", () => {
  it("покупка без ссылки получает её, вопрос «куда прислать» снят, приглашение закрыто, выбор человека НЕ меняется", async () => {
    await person({ inviteLink: OLD_INVITE });
    const waiting = await bought("COURSE50", { inviteLink: null, deliveryAwaitingChoice: true, createdAt: new Date() });
    await db.receiptCheck.create({
      data: {
        contactId: "c-1",
        kind: "valid",
        confidence: 95,
        reason: "ok",
        imageHash: "h-1",
        awaitingDeliveryChoice: true,
      },
    });

    const r = await issueOwnerLink("c-1", "web");

    expect(r).toMatchObject({ ok: true, kind: "web", closedInvite: true });
    const url = (r as { url: string }).url;
    const p = (await db.purchase.findUnique({ where: { id: waiting.id } }))!;
    expect(p.inviteLink).toBe(url);
    expect(p.deliveryAwaitingChoice).toBe(false);
    const after = (await db.contact.findUnique({ where: { id: "c-1" } }))!;
    // Ревью #95, п.2: ручная выдача не меняет выбор навсегда — следующая покупка идёт по каналу и режиму.
    expect(after.courseDeliveryChoice).toBeNull();
    expect(after.inviteLink).toBeNull();
    expect(revokeInviteLink).toHaveBeenCalledWith("tok", CHAT50, OLD_INVITE);
    // Проверка «уже выдано» для повторного чека теперь её видит.
    expect(await deliveredCoursesSince("c-1", new Date(Date.now() - 60_000))).toEqual(["COURSE50"]);
    const check = await db.receiptCheck.findFirst({ where: { contactId: "c-1" } });
    expect(check).toMatchObject({ awaitingDeliveryChoice: false, linkSent: true });
  });

  it("приглашение вошедшей покупки не перезаписывается (по нему узнаётся вход)", async () => {
    await person({ telegramUserId: "777" });
    const joined = await bought("COURSE50", { inviteLink: OLD_INVITE, joinedAt: new Date() });
    stubBotApi("member");

    await issueOwnerLink("c-1", "web");

    expect((await db.purchase.findUnique({ where: { id: joined.id } }))!.inviteLink).toBe(OLD_INVITE);
  });

  it("курса ещё нет на сайте — его группу не трогаем и выдачей сайта не помечаем", async () => {
    await person({ courseDeliveryChoice: "telegram", inviteLink: OLD_INVITE });
    const p = await bought("COURSE70", { inviteLink: null });
    platformReady.mockImplementation(async (c) => c !== "COURSE70");

    const r = await issueOwnerLink("c-1", "web");

    expect(r).toMatchObject({ ok: true, closedInvite: false });
    expect(revokeInviteLink).not.toHaveBeenCalled();
    expect((await db.purchase.findUnique({ where: { id: p.id } }))!.inviteLink).toBeNull();
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.courseDeliveryChoice).toBe("telegram");
  });
});

describe("гонка: одна выдача за раз на человека", () => {
  it("пока по ней идёт «Выдать ссылку», перевод по просьбе не выпускает вторую ссылку", async () => {
    await person({ courseDeliveryChoice: "web" });
    await bought("COURSE50", { createdAt: new Date() });
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    const inner = await withPersonLock("c-1", "busy", async () => {
      expect(await switchCourseChannel(c, "telegram", "bot")).toBe("failed");
      expect(await issueOwnerLink("c-1", "web")).toEqual({ ok: false, reason: "busy" });
      return "done";
    });

    expect(inner).toBe("done");
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.accessTokenId).toBe("Ab3kQ9xZpm");
  });
});

describe("соседнее: напоминание «не зашли в группу» после ручной выдачи сайта", () => {
  it("выбор «сайт», уроки уже открывала — в режиме Telegram напоминание не уходит, отметка ставится", async () => {
    const { runJoinReminders } = await import("../../src/joinReminder.js");
    await person({ paid: true, paidAt: new Date(Date.now() - 2 * DAY), courseDeliveryChoice: "web" });
    await bought("COURSE50", { firstOpenedAt: new Date(Date.now() - DAY) });
    await db.message.create({ data: { contactId: "c-1", direction: "IN", text: "спасибо" } });

    await runJoinReminders();

    expect(sendToContact).not.toHaveBeenCalled();
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.joinReminderAt).toBeInstanceOf(Date);
  });

  it("ревью #95: выбор не менялся, но покупке владелец выдал сайт — напоминание шлёт сайт, а не приглашение", async () => {
    const { runJoinReminders } = await import("../../src/joinReminder.js");
    await person({ paid: true, paidAt: new Date(Date.now() - 2 * DAY) });
    await bought("COURSE50", { firstOpenedAt: null, inviteLink: null });
    await db.message.create({ data: { contactId: "c-1", direction: "IN", text: "спасибо" } });
    expect(await issueOwnerLink("c-1", "web")).toMatchObject({ ok: true });
    sendToContact.mockClear();

    await runJoinReminders();

    expect(sentText()).toContain("/l/");
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });

  it("выбор «сайт», уроки НЕ открывала — напоминание со ссылкой на сайт уходит, как раньше", async () => {
    const { runJoinReminders } = await import("../../src/joinReminder.js");
    await person({ paid: true, paidAt: new Date(Date.now() - 2 * DAY), courseDeliveryChoice: "web" });
    await bought("COURSE50", { firstOpenedAt: null });
    await db.message.create({ data: { contactId: "c-1", direction: "IN", text: "спасибо" } });

    await runJoinReminders();

    expect(sentText()).toContain("ещё не открыли свои уроки");
    expect(sentText()).toContain("/l/");
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
  });
});

describe("БЛОКЕР 1, крайний случай: «в группе» только по старой отметке, Telegram её неизвестен", () => {
  it("сайт не закрываем и «вы уже в группе» не говорим — нельзя проверить, не вышла ли она", async () => {
    await person({ courseDeliveryChoice: "web", telegramUserId: null, joinedGroupAt: new Date(Date.now() - 8 * DAY) });
    await bought("COURSE50", { joinedAt: new Date(Date.now() - 8 * DAY) });
    const c = (await db.contact.findUnique({ where: { id: "c-1" } }))!;

    expect(await switchCourseChannel(c, "telegram", "owner")).toBe("unverifiable");

    expect(sendToContact).not.toHaveBeenCalled();
    expect(createOneTimeInviteLink).not.toHaveBeenCalled();
    expect((await db.contact.findUnique({ where: { id: "c-1" } }))!.accessTokenId).toBe("Ab3kQ9xZpm");
  });
});
