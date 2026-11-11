import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPrisma, restorePrisma, fakeContact, fakeFunnel, fakeStep, type PrismaMock } from "../helpers.js";
import type { Contact } from "@prisma/client";

/**
 * Воронка (разбор 11.11.2026): п.1 первый вопрос не глотается меню, п.2 одно
 * приветствие на две воронки, п.6 отложенные шаги отменяются, когда разговор
 * пошёл живьём, и пауза из-за Ширин — не «сбой Meta» с 11 повторами.
 */
vi.mock("../../src/messaging/send.js", () => ({ sendToContact: vi.fn(async () => "sent"), sendAttachmentToContact: vi.fn() }));
vi.mock("../../src/instagram.js", () => ({
  sendPrivateReply: vi.fn(async () => "pr-1"),
  replyToComment: vi.fn(),
  deleteComment: vi.fn(),
  metaChannelOf: () => "INSTAGRAM",
  mediaPermalink: vi.fn(),
}));
vi.mock("../../src/ai.js", () => ({ aiReplyToComment: vi.fn(async () => "ai") }));
vi.mock("../../src/systemAlerts.js", () => ({ notifyFunnelGaveUp: vi.fn() }));
vi.mock("../../src/ai/repeatGuard.js", () => ({ shouldSkipRequisitesStep: vi.fn(async () => false) }));

import {
  handleIncomingDm,
  cancelPendingFunnelSteps,
  runDueDeliveries,
  handleComment,
  settleDeferredFunnel,
  clientMessageStopsFunnel,
  FUNNEL_DEFERRED,
  FUNNEL_SKIPPED_AI_ANSWERED,
} from "../../src/funnel.js";
import { sendToContact } from "../../src/messaging/send.js";
import { sendPrivateReply } from "../../src/instagram.js";
import { aiReplyToComment } from "../../src/ai.js";
import { notifyFunnelGaveUp } from "../../src/systemAlerts.js";
import { ContactMessagingBlocked } from "../../src/messaging/automation.js";
import * as database from "../../src/db.js";

let db: PrismaMock;
const contact = fakeContact() as unknown as Contact;
beforeEach(() => {
  vi.clearAllMocks();
  db = mockPrisma();
  vi.spyOn(database, "logError").mockImplementation(() => {});
  db.model("contact").findUnique.mockResolvedValue(fakeContact());
  db.model("funnel").findMany.mockResolvedValue([fakeFunnel()]); // без ключевых слов — «на любое сообщение»
  db.model("delivery").findUnique.mockResolvedValue(null);
  db.model("delivery").findFirst.mockResolvedValue(null);
  db.model("funnelStep").findFirst.mockResolvedValueOnce(fakeStep()).mockResolvedValueOnce(null);
  db.model("delivery").create.mockImplementation(async () => ({ id: "d1", funnelId: "funnel-1", contactId: contact.id, contact }));
  db.model("delivery").updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  restorePrisma();
  vi.restoreAllMocks();
});

describe("п.1 первое сообщение", () => {
  it("настоящий вопрос: меню-приветствие не уходит, воронка ОТЛОЖЕНА до ответа ИИ (не «ответил ИИ» заранее)", async () => {
    const handled = await handleIncomingDm(contact, "Как долго доступен курс?", null);
    expect(handled).toBe(false);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("delivery").create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DONE", lastError: FUNNEL_DEFERRED }) }),
    );
  });
  it("фото первым сообщением (чек) — тоже без меню", async () => {
    expect(await handleIncomingDm(contact, null, null, { hasAttachments: true })).toBe(false);
    expect(sendToContact).not.toHaveBeenCalled();
  });
  it("просто «Салом» — меню воронки, как раньше", async () => {
    expect(await handleIncomingDm(contact, "Салом", null)).toBe(true);
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });
  it("ИИ выключен / пауза — лучше меню, чем тишина", async () => {
    expect(await handleIncomingDm(contact, "Как долго доступен курс?", null, { aiAvailable: false })).toBe(true);
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });
});

describe("п.2 одно приветствие на две воронки", () => {
  it("меню с комментария уже ушло — на «Салом» в директ второе меню не шлём", async () => {
    db.model("delivery").findFirst.mockResolvedValue({ id: "comment-delivery" });
    expect(await handleIncomingDm(contact, "Салом", null)).toBe(true);
    expect(sendToContact).not.toHaveBeenCalled();
  });
  it("меню в директ уже ушло — комментарий «+» получает только «написали в директ»", async () => {
    db.model("funnel").findMany.mockResolvedValue([fakeFunnel({ id: "cf", trigger: "COMMENT", anyComment: true })]);
    db.model("seenComment").findUnique.mockResolvedValue(null);
    db.model("contact").upsert.mockResolvedValue(fakeContact());
    db.model("delivery").findFirst.mockResolvedValue({ id: "dm-delivery" });
    await handleComment({ commentId: "c1", mediaId: null, igUserId: "ig-1", username: null, text: "+" });
    expect(sendPrivateReply).not.toHaveBeenCalled();
    expect(aiReplyToComment).not.toHaveBeenCalled();
  });
});

describe("п.6 отложенные шаги воронки", () => {
  it("отменяются только цепочки «в пути»: кнопки ждут нажатия", async () => {
    db.model("delivery").updateMany.mockResolvedValue({ count: 2 });
    expect(await cancelPendingFunnelSteps("contact-1", "остановлено: клиент написал сам")).toBe(2);
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith({
      where: { contactId: "contact-1", state: "ACTIVE" },
      data: expect.objectContaining({ state: "DONE", nextRunAt: null }),
    });
  });
  it("Ширин ведёт разговор — шаг не уходит и не ждёт конца паузы, а отменяется", async () => {
    const talking = { ...fakeContact(), humanTakenOverAt: new Date(), humanSilencedUntil: null };
    db.model("delivery").findMany.mockResolvedValue([{ id: "d1", funnelId: "funnel-1", nextOrder: 21, failCount: 0, contact: talking, funnel: fakeFunnel() }]);
    db.model("funnelStep").findUnique.mockResolvedValue(fakeStep({ order: 21, text: "видео" }));
    await runDueDeliveries();
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("delivery").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DONE", lastError: expect.stringContaining("Ширин") }) }),
    );
  });
  it("дверь отправки отказала из-за паузы — без 11 повторов и без тревоги «воронка сдалась»", async () => {
    db.model("delivery").findMany.mockResolvedValue([{ id: "d1", funnelId: "funnel-1", nextOrder: 23, failCount: 0, contact, funnel: fakeFunnel() }]);
    db.model("funnelStep").findUnique.mockResolvedValue(fakeStep({ order: 23, text: "905 355 355" }));
    vi.mocked(sendToContact).mockRejectedValueOnce(new ContactMessagingBlocked("contact policy"));
    await runDueDeliveries();
    expect(notifyFunnelGaveUp).not.toHaveBeenCalled();
    expect(db.model("delivery").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "DONE", lastError: expect.stringContaining("contact policy") }) }),
    );
  });
});

describe("ревью 11.11: отмена шага устойчива, даже если шаг «в полёте»", () => {
  it("клиент написал, пока шаг отправлялся — следующий шаг не оживает", async () => {
    // Маленькая «база» одной доставки: update/updateMany применяют data, если where совпал.
    const row: Record<string, unknown> = { id: "d1", contactId: "contact-1", state: "ACTIVE", nextOrder: 21 };
    const matches = (where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => row[k] === v);
    db.model("delivery").update.mockImplementation(async (args: unknown) => {
      Object.assign(row, (args as { data: object }).data);
      return row;
    });
    db.model("delivery").updateMany.mockImplementation(async (args: unknown) => {
      const { where, data } = args as { where: Record<string, unknown>; data: object };
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    db.model("delivery").findMany.mockResolvedValue([{ ...row, funnelId: "funnel-1", failCount: 0, contact, funnel: fakeFunnel() }]);
    db.model("funnelStep").findUnique.mockResolvedValue(fakeStep({ order: 21, text: "видео" }));
    db.model("funnelStep").findFirst.mockReset().mockResolvedValue(fakeStep({ order: 22, delaySeconds: 60, text: "реквизиты" }));
    // Во время отправки шага клиент пишет сам — webhook.ts отменяет цепочку.
    vi.mocked(sendToContact).mockImplementationOnce(async () => {
      await cancelPendingFunnelSteps("contact-1", "остановлено: клиент написал сам");
      return "sent";
    });
    await runDueDeliveries();
    expect(row.state).toBe("DONE");
    expect(row.nextOrder).toBe(21);
  });
  it("цепочку отменили между выборкой и захватом — шаг вообще не уходит", async () => {
    db.model("delivery").findMany.mockResolvedValue([{ id: "d1", funnelId: "funnel-1", nextOrder: 21, failCount: 0, contact, funnel: fakeFunnel() }]);
    db.model("delivery").updateMany.mockResolvedValue({ count: 0 });
    db.model("funnelStep").findUnique.mockResolvedValue(fakeStep({ order: 21, text: "видео" }));
    await runDueDeliveries();
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

describe("ревью 11.11: «воронка пропущена» — только когда ответ ИИ реально ушёл", () => {
  const since = new Date(Date.now() - 1_000);
  const deferredRow = () => ({
    id: "d1",
    funnelId: "funnel-1",
    contactId: contact.id,
    state: "DONE",
    lastError: FUNNEL_DEFERRED,
    createdAt: new Date(),
    funnel: fakeFunnel(),
    contact,
  });
  beforeEach(() => {
    db.model("delivery").findMany.mockResolvedValue([deferredRow()]);
    db.model("delivery").findUnique.mockResolvedValue(deferredRow());
    db.model("delivery").update.mockImplementation(async () => ({ id: "d1", funnelId: "funnel-1", contactId: contact.id, contact }));
  });
  it("ИИ ответил — меню не уходит, отметка «ответил ИИ»", async () => {
    db.model("message").findMany.mockResolvedValue([{ text: "Курс остаётся у вас навсегда" }]);
    await settleDeferredFunnel(contact.id, since);
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith({
      where: { id: "d1", lastError: FUNNEL_DEFERRED },
      data: { lastError: FUNNEL_SKIPPED_AI_ANSWERED },
    });
  });
  it("ИИ промолчал (ключи, фильтры, «не по делу», ошибка) — уходит обычное меню воронки", async () => {
    db.model("message").findMany.mockResolvedValue([]);
    await settleDeferredFunnel(contact.id, since);
    expect(sendToContact).toHaveBeenCalledWith(expect.objectContaining({ id: contact.id }), "Привет!", []);
    // Захват места атомарный: два хода не отправят меню дважды.
    expect(db.model("delivery").updateMany).toHaveBeenCalledWith({
      where: { id: "d1", state: "DONE", lastError: FUNNEL_DEFERRED },
      data: { state: "ACTIVE", lastError: null },
    });
  });
  it("кончился бюджет — «напишите позже» не ответ: меню всё равно уходит", async () => {
    db.model("message").findMany.mockResolvedValue([{ text: "Хозир чавоб дода наметонам, каме дертар нависен" }]);
    await settleDeferredFunnel(contact.id, since);
    expect(sendToContact).toHaveBeenCalledTimes(1);
  });
  it("место уже занял другой ход — меню второй раз не уходит", async () => {
    db.model("message").findMany.mockResolvedValue([]);
    db.model("delivery").updateMany.mockResolvedValue({ count: 0 });
    await settleDeferredFunnel(contact.id, since);
    expect(sendToContact).not.toHaveBeenCalled();
  });
  it("Ширин уже ведёт разговор — меню не шлём", async () => {
    const talking = { ...fakeContact(), humanTakenOverAt: new Date(), humanSilencedUntil: null };
    db.model("delivery").findMany.mockResolvedValue([{ ...deferredRow(), contact: talking }]);
    db.model("message").findMany.mockResolvedValue([]);
    await settleDeferredFunnel(contact.id, since);
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

describe("ревью 11.11: когда сообщение клиента отменяет шаги воронки", () => {
  const withSettings = (values: Record<string, string>) =>
    db.model("setting").findUnique.mockImplementation(async (args: unknown) => {
      const key = (args as { where: { key: string } }).where.key;
      return key in values ? { key, value: values[key] } : null;
    });
  it("ИИ включён, ключи есть, вопрос — отменяет", async () => {
    withSettings({ aiEnabled: "true", geminiKey: "test-key" });
    expect(await clientMessageStopsFunnel("Кай сар мешавад?", [])).toBe(true);
  });
  it("пустяк «рахмат» / «ок» — не отменяет", async () => {
    withSettings({ aiEnabled: "true", geminiKey: "test-key" });
    expect(await clientMessageStopsFunnel("рахмат", [])).toBe(false);
    expect(await clientMessageStopsFunnel("ок", [])).toBe(false);
  });
  it("ИИ выключен, экстренная пауза или нет ключей — не отменяет", async () => {
    withSettings({ aiEnabled: "false", geminiKey: "test-key" });
    expect(await clientMessageStopsFunnel("Кай сар мешавад?", [])).toBe(false);
    withSettings({ aiEnabled: "true", botFrozen: "true", geminiKey: "test-key" });
    expect(await clientMessageStopsFunnel("Кай сар мешавад?", [])).toBe(false);
    withSettings({ aiEnabled: "true" });
    expect(await clientMessageStopsFunnel("Кай сар мешавад?", [])).toBe(false);
  });
  it("фото без подписи (чек) — отменяет", async () => {
    withSettings({ aiEnabled: "true", geminiKey: "test-key" });
    expect(await clientMessageStopsFunnel(null, [{ kind: "image" }])).toBe(true);
  });
});
