import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

/**
 * «ПОЗОВИТЕ ЧЕЛОВЕКА» (решение владельца 15.11.2026): клиент сам попросил живого
 * человека — дальше отвечает ТОЛЬКО Ширин. Бот молчит на всех путях (живой вебхук,
 * сторож, повторы, воронка), пока Ширин не ответит этому клиенту или владелец не
 * вернёт помощника вручную. Instagram и Messenger; WhatsApp и сайт — как раньше
 * (час тишины). Деньги не блокируются: проверенный чек и ссылка проходят. Данные выдуманные.
 */
const mocks = vi.hoisted(() => ({
  prisma: {
    contact: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    whatsAppInbox: { findFirst: vi.fn(), updateMany: vi.fn() },
    setting: { findUnique: vi.fn() },
  },
}));
vi.mock("../../src/db.js", () => ({
  prisma: mocks.prisma,
  getSetting: vi.fn(async () => null),
  logError: vi.fn(),
}));
vi.mock("../../src/whatsapp/client.js", () => ({
  bridgeRequest: vi.fn(),
  whatsappConfigured: () => true,
  BridgeError: class extends Error {},
}));

import {
  ASKED_HUMAN_HOLD_UNTIL,
  askedHumanHold,
  askedHumanSilenceUntil,
  automationBlockKind,
  assertContactMessagingAllowed,
  contactAutomationBlocked,
  withContactMessaging,
  withVerifiedReceiptDelivery,
  ContactMessagingBlocked,
} from "../../src/messaging/automation.js";
import { conversationAdminRouter } from "../../src/whatsapp/routes.js";

const NOW = Date.parse("2026-11-15T07:00:00Z");
const held = {
  id: "c1",
  channel: "INSTAGRAM",
  personal: false,
  spamBlockedAt: null,
  whatsappSavedContact: false,
  humanTakenOverAt: null,
  humanSilencedUntil: ASKED_HUMAN_HOLD_UNTIL,
};

describe("дверь: «позовите человека» держит бота до ответа Ширин", () => {
  it("Instagram и Messenger — до ответа Ширин; WhatsApp и сайт — как раньше, час", () => {
    expect(askedHumanSilenceUntil("INSTAGRAM", NOW)).toEqual(ASKED_HUMAN_HOLD_UNTIL);
    expect(askedHumanSilenceUntil("MESSENGER", NOW)).toEqual(ASKED_HUMAN_HOLD_UNTIL);
    expect(askedHumanSilenceUntil("WHATSAPP", NOW)).toEqual(new Date(NOW + 3_600_000));
    expect(askedHumanSilenceUntil("WEB", NOW)).toEqual(new Date(NOW + 3_600_000));
  });

  it("держит сколько угодно долго: и через неделю бот не отвечает, причина в журнале — «просил человека»", () => {
    const weekLater = NOW + 7 * 86_400_000;
    expect(askedHumanHold(held)).toBe(true);
    expect(contactAutomationBlocked(held, "reply")).toBe(true);
    expect(automationBlockKind(held, weekLater)).toBe("asked_human");
    expect(askedHumanHold({ ...held, humanSilencedUntil: new Date(NOW + 3_600_000) })).toBe(false);
  });

  it("ДЕНЬГИ: ссылка по проверенному чеку проходит дверь, обычный ответ — нет", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue(held);
    await expect(assertContactMessagingAllowed("c1", "reply")).rejects.toBeInstanceOf(ContactMessagingBlocked);
    await expect(
      withVerifiedReceiptDelivery("c1", "hash-1", () =>
        withContactMessaging("c1", "verified_receipt_access", () =>
          assertContactMessagingAllowed("c1", "verified_receipt_access"),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("владелец возвращает помощника вручную", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/c", conversationAdminRouter);
    server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/c`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => vi.clearAllMocks());

  it("список «бот молчит» показывает и тех, кто просил человека (Instagram), а не только паузу после ответа", async () => {
    mocks.prisma.contact.findMany.mockResolvedValue([]);
    await fetch(`${base}/paused`);
    const where = mocks.prisma.contact.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      OR: [{ humanTakenOverAt: { not: null } }, { humanSilencedUntil: { gte: expect.any(Date) } }],
    });
    expect(where.OR[1].humanSilencedUntil.gte.getTime()).toBeLessThanOrEqual(ASKED_HUMAN_HOLD_UNTIL.getTime());
  });

  it("«Вернуть помощника» снимает удержание", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue(held);
    const res = await fetch(`${base}/c1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ humanSilencedUntil: null }) }),
    );
  });
});
