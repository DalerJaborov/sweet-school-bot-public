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
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

import { maybeRestoreAccess, looksLikeAccessRequest } from "../../src/course/recovery.js";
import { recoveryCodeFor, recoveryCodeForToken, parseRecoveryCode } from "../../src/course/linkCode.js";
import type { Contact } from "@prisma/client";

const TOKEN = "Ab3kQ9xZpm";
const CODE = recoveryCodeFor(TOKEN);

// Покупательница: Instagram. Пишущая: WhatsApp, другой контакт.
const buyer = fakeContact({ id: "buyer-1", igUserId: "ig-buyer", username: "gulnora", name: "Гулнора", accessTokenId: TOKEN }) as unknown as Contact;
const writer = fakeContact({ id: "writer-1", igUserId: "992900000000", channel: "WHATSAPP", username: null }) as unknown as Contact;

const WEB_MODE = { courseDeliveryMode: "web", telegramBotToken: "token", telegramOwnerChatId: "owner" };
const settings = (values: Record<string, string>) => async ({ where }: { where: { key: string } }) =>
  values[where.key] ? { value: values[where.key] } : null;

function purchase(contactId: string, over: Record<string, unknown> = {}) {
  return { id: `p-${contactId}`, contactId, course: "COURSE50", revokedAt: null, linkReissueCount: 0, linkReissuedAt: null, createdAt: new Date("2026-10-01"), ...over };
}

describe("публичный код покупательницы", () => {
  it("детерминирован, в виде XXXX-XXXX и НЕ содержит код ссылки", () => {
    expect(CODE).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(recoveryCodeFor(TOKEN)).toBe(CODE);
    expect(CODE.replace("-", "").toLowerCase()).not.toContain(TOKEN.toLowerCase().slice(0, 4));
    expect(recoveryCodeFor("Zz9yX8wVu7")).not.toBe(CODE);
  });

  it("для не-короткого токена кода нет", () => {
    expect(recoveryCodeForToken("eyJhbGciOi.старый.jwt")).toBeNull();
    expect(recoveryCodeForToken("")).toBeNull();
    expect(recoveryCodeForToken(TOKEN)).toBe(CODE);
  });

  it("разбирается из фразы на обоих языках, в любом регистре", () => {
    expect(parseRecoveryCode(`Здравствуйте! Моя ссылка не открывается. Мой код: ${CODE}`)).toBe(CODE);
    expect(parseRecoveryCode(`Рамзи ман: ${CODE.toLowerCase()}`)).toBe(CODE);
    expect(parseRecoveryCode("ссылка не открывается")).toBeNull();
    expect(parseRecoveryCode("мой номер 992-905")).toBeNull();
  });

  it("сообщение с одним кодом считается просьбой о доступе", () => {
    expect(looksLikeAccessRequest(`Мой код: ${CODE}`)).toBe(true);
  });
});

describe("maybeRestoreAccess: код из ссылки", () => {
  let db: PrismaMock;
  beforeEach(() => {
    db = mockPrisma();
    db.model("contact").findMany.mockResolvedValue([buyer]);
    db.model("contact").findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === buyer.id ? buyer : writer));
    db.model("contact").updateMany.mockResolvedValue({ count: 1 });
    db.model("setting").findUnique.mockImplementation(settings(WEB_MODE));
    sendText.mockClear();
    sendTelegramMessage.mockClear();
  });
  afterEach(restorePrisma);

  it("ГЛАВНОЕ: код ДРУГОГО контакта — ссылку не выдаёт, владельцу приходит кто покупатель", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(buyer.id)]);
    db.model("receiptCheck").count.mockResolvedValue(1); // деньги видны — и всё равно сама не выдаёт

    const result = await maybeRestoreAccess(writer, `Здравствуйте! Моя ссылка на уроки не открывается. Мой код: ${CODE}`);

    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).not.toMatch(/\/l\//);
    expect(String(sendText.mock.calls[0][1])).toContain("Передала Ширин");
    const alert = String(sendTelegramMessage.mock.calls[0][2]);
    expect(alert).toContain("Гулнора");
    expect(alert).toContain("@gulnora");
    expect(alert).toContain("COURSE50");
    expect(alert).toContain("2026-10-01");
    expect(alert).toContain("ДРУГОГО чата");
    expect(alert).toContain("WHATSAPP 992900000000");
    expect(alert).not.toContain(TOKEN);
  });

  it("по-таджикски — ответ таджикский, без смайликов", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(buyer.id)]);
    await maybeRestoreAccess(writer, `Ассалому алейкум! Пайванди дарсҳои ман кушода намешавад. Рамзи ман: ${CODE}`);
    const text = String(sendText.mock.calls[0][1]);
    expect(text).toContain("Ширин");
    expect(text).toMatch(/[ӯқҳғӣ]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("отозванная покупка по коду другого контакта — не восстанавливается, владелец предупреждён", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(buyer.id, { revokedAt: new Date() })]);
    const result = await maybeRestoreAccess(writer, `Мой код: ${CODE}`);
    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(db.model("purchase").update).not.toHaveBeenCalled();
    expect(String(sendTelegramMessage.mock.calls[0][2])).toContain("ОТОЗВАН");
    expect(String(sendText.mock.calls[0][1])).not.toMatch(/\/l\//);
  });

  it("код совпал с ЭТИМ чатом — работает прежний сценарий: ссылка выдаётся сама", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(buyer.id)]);
    db.model("receiptCheck").count.mockResolvedValue(1);
    db.model("device").findMany.mockResolvedValue([]);
    db.model("purchase").findUnique.mockResolvedValue({ courseRef: { deviceLimit: 3 } });

    const result = await maybeRestoreAccess(buyer, `Моя ссылка не открывается. Мой код: ${CODE}`);

    expect(result).toMatchObject({ handled: true, outcome: "reissued" });
    expect(String(sendText.mock.calls[0][1])).toMatch(/\/l\/[A-Za-z0-9]{10}/);
  });

  it("код совпал, но покупка отозвана — как раньше: revoked, ссылка не выдаётся", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(buyer.id, { revokedAt: new Date() })]);
    const result = await maybeRestoreAccess(buyer, `Мой код: ${CODE}`);
    expect(result).toMatchObject({ handled: true, outcome: "revoked" });
  });

  it("подделанный код (никому не принадлежит) — как сейчас: смотрим только на этот чат", async () => {
    db.model("purchase").findMany.mockResolvedValue([]); // у пишущей покупок нет
    const result = await maybeRestoreAccess(writer, "Моя ссылка не открывается. Мой код: DEAD-BEEF");
    expect(result).toEqual({ handled: false });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("подделанный код у человека с покупкой в ЭТОМ чате — прежний сценарий, чужих данных не видно", async () => {
    db.model("purchase").findMany.mockResolvedValue([purchase(writer.id)]);
    db.model("receiptCheck").count.mockResolvedValue(0);
    db.model("purchase").count.mockResolvedValue(0);
    const result = await maybeRestoreAccess(writer, "Моя ссылка не открывается. Мой код: DEAD-BEEF");
    expect(result).toMatchObject({ handled: true, outcome: "escalated" });
    expect(String(sendTelegramMessage.mock.calls[0][2])).not.toContain("Гулнора");
  });
});
