import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, type PrismaMock } from "../helpers.js";

const sendText = vi.fn(async (..._a: unknown[]) => "mid-1");
const sendTelegramMessage = vi.fn(async (..._a: unknown[]) => 1);

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
  chatsForKind: vi.fn(async () => ["owner-1"]),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { handlePhoneChange, phoneChangeProof, approveTransferByOwner, resetPhoneChangeState } from "../../src/course/phoneChange.js";
import { recoveryCodeFor } from "../../src/course/linkCode.js";
import { claimPlayback, resetPlaybackLocks } from "../../src/course/playbackLock.js";
import type { Contact } from "@prisma/client";

const TOKEN = "Ab3kQ9xZpm";
const CODE = recoveryCodeFor(TOKEN);

const usedBeforeBase = { deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 2 * 86_400_000) };
const contact = fakeContact({
  id: "c-1",
  channel: "WHATSAPP",
  igUserId: "992900000000",
  username: null,
  name: "Гулнора",
  accessTokenId: TOKEN,
  accessIssuedAt: new Date("2026-10-20"),
  deviceSwaps: 0,
  deviceSwapAt: null,
  preferredLanguage: "ru",
}) as unknown as Contact;

const usedBefore = { ...contact, ...usedBeforeBase } as unknown as Contact;

describe("смена телефона через бота", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    resetPhoneChangeState();
    sendText.mockClear();
    sendTelegramMessage.mockClear();
    db.model("contact").findUnique.mockResolvedValue(contact);
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    db.model("device").findMany.mockResolvedValue([
      { id: "old-1", userAgent: "Android", lastCity: null, lastSeenAt: new Date("2026-11-07") },
      { id: "old-2", userAgent: "Android", lastCity: null, lastSeenAt: new Date("2026-11-06") },
    ]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("offlineSignup").findMany.mockResolvedValue([]);
    db.model("setting").findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === "telegramBotToken" ? { value: "token" } : null,
    );
  });
  afterEach(restorePrisma);

  it("ГЛАВНОЕ: код из её ссылки — новая ссылка, старая аннулирована, устройства удалены, месяц потрачен", async () => {
    const outcome = await handlePhoneChange(contact, `сменила телефон, мой код ${CODE}`, "ru");

    expect(outcome).toBe("changed");
    // Новая ссылка записана с проверкой «прежняя ещё та же» (гонки не затирают друг друга).
    const claim = db.model("contact").updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: { accessTokenId: string };
    };
    expect(claim.where.accessTokenId).toBe(TOKEN);
    expect(claim.data.accessTokenId).not.toBe(TOKEN);
    expect(String(sendText.mock.calls[0][1])).toContain(`/l/${claim.data.accessTokenId}`);
    expect(String(sendText.mock.calls[0][1])).toContain("Прежняя ссылка и старый телефон больше не открывают");
    expect(db.model("device").deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old-1", "old-2"] } } });
    const upd = db.model("contact").update.mock.calls[0][0] as { data: { deviceSwaps: number } };
    expect(upd.data.deviceSwaps).toBe(1);
    // Владельцу — сводка без кнопки.
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("код из ссылки");
    expect(JSON.stringify(sendTelegramMessage.mock.calls[0][4])).toContain("nf:off:security"); // только кнопка «Не присылать такое»
  });

  it("чужой код не считается доказательством", async () => {
    expect(await phoneChangeProof(contact, `сменила телефон ${recoveryCodeFor("Zz9yX8wVu7")}`)).toBeNull();
  });

  it("ГЛАВНОЕ (решение владельца): без кода и чека, но из её чата с оплатой — перенос делается, в журнале «сообщение из её чата»", async () => {
    expect(await phoneChangeProof(contact, "сменила телефон, дайте ссылку")).toBeNull();

    const outcome = await handlePhoneChange(contact, "сменила телефон, дайте ссылку", "ru");

    expect(outcome).toBe("changed");
    expect(db.model("device").deleteMany).toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("сообщение из её чата покупки");
  });

  it("доказательство есть, но перенос в этом месяце уже был — не делаем, «передала Ширин», карточка с кнопкой", async () => {
    const used = {
      ...contact,
      deviceSwaps: 1,
      deviceSwapAt: new Date(Date.now() - 5 * 86_400_000),
    } as unknown as Contact;
    db.model("device").findMany.mockResolvedValue([
      { userAgent: "Mozilla/5.0 (iPhone)", lastCity: "TJ", lastSeenAt: new Date("2026-11-07") },
    ]);

    expect(await handlePhoneChange(used, `сменила телефон ${CODE}`, "ru")).toBe("limit");

    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).not.toContain("30");
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("iPhone");
    expect(JSON.stringify(sendTelegramMessage.mock.calls[0][4])).toContain("mn:tr:c-1");
  });

  it("чек картинкой: тот же файл, уже принятый по ЕЁ контакту — доказательство; сам чек не пишется и в оплату не идёт", async () => {
    db.model("receiptCheck").count.mockResolvedValue(1);

    const outcome = await handlePhoneChange(contact, "сменила телефон", "ru", ["hash-1"]);

    expect(outcome).toBe("changed");
    expect(db.model("receiptCheck").count).toHaveBeenCalledWith({
      where: {
        contactId: "c-1",
        imageHash: { in: ["hash-1"] },
        OR: [{ ownerDecision: "APPROVED" }, { linkSent: true }],
      },
    });
    expect(db.model("receiptCheck").create).not.toHaveBeenCalled();
    expect(db.model("receiptCheck").update).not.toHaveBeenCalled();
    expect(db.model("purchase").create).not.toHaveBeenCalled();
  });

  it("чужой чек (не принятый по этому контакту) доказательством не считается", async () => {
    expect(await phoneChangeProof(contact, "сменила телефон", ["hash-foreign"])).toBeNull();
  });

  it("имя и телефон: оба совпали — доказательство; только телефон или только имя — нет", async () => {
    expect(await phoneChangeProof(contact, "Меня зовут Гулнора, номер +992 900 000 000")).toBe("name_phone");
    expect(await phoneChangeProof(contact, "Меня зовут Мадина, номер 900000000")).toBeNull();
    expect(await phoneChangeProof(contact, "Гулнора")).toBeNull();
    expect(await phoneChangeProof(contact, "Гулнора, номер 911111111")).toBeNull();
  });

  it("у Instagram-контакта номера в базе нет: имя с любым номером не проходит", async () => {
    const ig = { ...contact, channel: "INSTAGRAM", igUserId: "17841400000" } as unknown as Contact;
    expect(await phoneChangeProof(ig, "Гулнора, номер 900000000")).toBeNull();
  });

  it("ссылка не доставилась — прежняя ссылка возвращается, месячный перенос не тратится, владельцу тревога", async () => {
    sendText.mockRejectedValueOnce(new Error("окно 24 часа закрыто"));

    expect(await handlePhoneChange(contact, `сменила телефон ${CODE}`, "ru")).toBe("send_failed");

    // Устройства сняты ДО отправки (одна транзакция со счётчиком), но счётчик и ссылка возвращены.
    expect(db.model("device").deleteMany).toHaveBeenCalled();
    const restore = db.model("contact").updateMany.mock.calls[1][0] as { data: { accessTokenId: string } };
    expect(restore.data.accessTokenId).toBe(TOKEN);
    const counter = db.model("contact").update.mock.calls.at(-1)?.[0] as { data: { deviceSwaps: number } };
    expect(counter.data.deviceSwaps).toBe(0);
    expect(sendTelegramMessage.mock.calls.map((c) => String(c[2])).join("|")).toContain("ссылка не доставлена");
  });

  it("заблокированное устройство держит место: ни бот, ни кнопка владельца его не снимают (блокировка выше переноса)", async () => {
    db.model("device").count.mockResolvedValue(1);
    expect(await handlePhoneChange(contact, `сменила телефон ${CODE}`, "ru")).toBe("blocked");
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls.at(-1)?.[2])).toContain("разблокируйте");
    expect(JSON.stringify(sendTelegramMessage.mock.calls.at(-1)?.[4])).toContain("mn:tr:c-1");

    expect(await approveTransferByOwner("c-1")).toBe("blocked");
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
  });

  it("покупательница с сайта (WEB): бот сам не переносит — владельцу карточка (правило PR 62)", async () => {
    const web = { ...contact, channel: "WEB" } as unknown as Contact;
    expect(await handlePhoneChange(web, "сменила телефон", "ru")).toBe("no_link");
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
    expect(JSON.stringify(sendTelegramMessage.mock.calls.at(-1)?.[4])).toContain("mn:tr:c-1");
  });

  it("доступ отозван — ссылку не выдаём вообще", async () => {
    db.model("contact").findUnique.mockResolvedValue({ ...contact, accessRevokedAt: new Date() });
    expect(await handlePhoneChange(contact, `сменила телефон ${CODE}`, "ru")).toBe("no_link");
    expect(db.model("contact").updateMany).not.toHaveBeenCalled();
    expect(db.model("device").deleteMany).not.toHaveBeenCalled();
  });

  it("карточка владельца одноразовая: без карточки — «устарела»; после перенос; повторное нажатие — «устарела»", async () => {
    expect(await approveTransferByOwner("c-1")).toBe("expired");

    await handlePhoneChange(usedBefore, `сменила телефон ${CODE}`, "ru"); // лимит: карточка ушла владельцу
    sendText.mockClear();
    const used = { ...contact, deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 2 * 86_400_000) };
    db.model("contact").findUnique.mockResolvedValue(used);
    expect(await approveTransferByOwner("c-1")).toBe("ok");
    expect(String(sendText.mock.calls[0][1])).toContain("Ширин разрешила перенос");
    expect(String(sendText.mock.calls[0][1])).toMatch(/\/l\/[A-Za-z0-9]{10}/);
    expect(db.model("device").deleteMany).toHaveBeenCalled();
    // Счётчик растёт после доставки, окно начинается заново.
    const upd = db.model("contact").update.mock.calls.at(-1)?.[0] as { data: { deviceSwaps: number } };
    expect(upd.data.deviceSwaps).toBe(1);

    expect(await approveTransferByOwner("c-1")).toBe("expired");
  });

  it("ОДНОВРЕМЕННЫЕ нажатия на карточку: переносит только одно, остальные — «устарела»; после сбоя карточка не оживает", async () => {
    await handlePhoneChange(usedBefore, `сменила телефон ${CODE}`, "ru"); // лимит: карточка ушла владельцу
    const used = { ...contact, deviceSwaps: 1, deviceSwapAt: new Date(Date.now() - 2 * 86_400_000) };
    db.model("contact").findUnique.mockResolvedValue(used);

    const results = await Promise.all([approveTransferByOwner("c-1"), approveTransferByOwner("c-1"), approveTransferByOwner("c-1")]);

    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "expired")).toHaveLength(2);
    expect(db.model("contact").updateMany).toHaveBeenCalledTimes(1);
    // Сбой отправки: карточка не взводится заново.
    await handlePhoneChange(usedBefore, `сменила телефон ${CODE}`, "ru");
    sendText.mockRejectedValueOnce(new Error("окно закрыто"));
    expect(await approveTransferByOwner("c-1")).toBe("failed");
    expect(await approveTransferByOwner("c-1")).toBe("expired");
  });

  it("фото без совпадения (домашка) после запроса доказательства — не доказательство и бот молчит", async () => {
    await handlePhoneChange(contact, "сменила телефон", "ru");
    sendText.mockClear();
    expect(await phoneChangeProof(contact, "", ["hash-homework"])).toBeNull();
  });

  it("по-таджикски сообщения приходят на таджикском", async () => {
    const tg = { ...contact, preferredLanguage: "tg" } as unknown as Contact;
    db.model("contact").findUnique.mockResolvedValue(tg);
    await handlePhoneChange(tg, "телефонамро иваз кардам", "tg");
    expect(String(sendText.mock.calls[0][1])).toContain("Дастрасиро ба телефони нав гузарондам. Ана ссылкаи нав");
  });
});

describe("одновременный просмотр", () => {
  beforeEach(resetPlaybackLocks);

  it("одно устройство (несколько вкладок/браузеров телефона) — не блокирует само себя", () => {
    expect(claimPlayback("c-1", "phone")).toBe(true);
    expect(claimPlayback("c-1", "phone")).toBe(true);
  });

  it("второй телефон, пока первый играет, — отказ", () => {
    const t0 = 1_000_000;
    expect(claimPlayback("c-1", "phone-A", t0)).toBe(true);
    expect(claimPlayback("c-1", "phone-B", t0 + 30_000)).toBe(false);
    // Первый продолжает — замок продлён.
    expect(claimPlayback("c-1", "phone-A", t0 + 60_000)).toBe(true);
    expect(claimPlayback("c-1", "phone-B", t0 + 100_000)).toBe(false);
  });

  it("первый замолчал на две минуты — второй может играть", () => {
    const t0 = 1_000_000;
    claimPlayback("c-1", "phone-A", t0);
    expect(claimPlayback("c-1", "phone-B", t0 + 121_000)).toBe(true);
  });

  it("разные покупательницы друг другу не мешают", () => {
    expect(claimPlayback("c-1", "phone-A")).toBe(true);
    expect(claimPlayback("c-2", "phone-B")).toBe(true);
  });
});
