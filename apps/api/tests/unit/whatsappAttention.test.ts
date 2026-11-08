import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
const mocks = vi.hoisted(() => ({
  prisma: {
    whatsAppInbox: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    contact: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  bridgeRequest: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: mocks.prisma, getSetting: vi.fn(), logError: vi.fn() }));
vi.mock("../../src/whatsapp/client.js", () => ({ bridgeRequest: mocks.bridgeRequest, whatsappConfigured: () => true, BridgeError: class extends Error {} }));
import { conversationAdminRouter } from "../../src/whatsapp/routes.js";
import { attentionError, attentionText, classifyAttention, describeIncoming, chatTitle } from "../../src/whatsapp/attention.js";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use("/c", conversationAdminRouter);
  server = createServer(app).listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/c`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { vi.clearAllMocks(); mocks.bridgeRequest.mockResolvedValue({}); });

const row = (over: Record<string, unknown>) => ({ id: "i", chatId: "992900000000@c.us", contactId: "c1", status: "attention", attentionReason: "generation",
  payload: JSON.stringify({ text: "Сколько стоит курс?" }), createdAt: new Date("2026-11-08T10:00:00Z"), ...over });
const wa = { id: "c1", channel: "WHATSAPP", name: null, humanTakenOverAt: null, personal: false, spamBlockedAt: null, whatsappSavedContact: false };
const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("attention reasons", () => {
  it("speaks plain Russian and falls back safely", () => {
    expect(classifyAttention(attentionError("attachment", "internal"))).toBe("attachment");
    expect(classifyAttention(new Error("boom"))).toBe("generation");
    expect(attentionText("media_unavailable")).not.toMatch(/mediaUnavailable|download|error/i);
    expect(attentionText("unknown-code")).toBe(attentionText("generation"));
    expect(attentionText(null)).toBe(attentionText("generation"));
  });
  it("describes what the client sent without leaking attachment data", () => {
    expect(describeIncoming(JSON.stringify({ text: "  привет ", media: { mimeType: "audio/ogg", data: "AAAA" } }))).toEqual({ text: "привет", kind: "voice" });
    expect(describeIncoming(JSON.stringify({ text: "", mediaUnavailable: "download_failed" })).kind).toBe("file");
    expect(describeIncoming("not json")).toEqual({ text: "", kind: "text" });
    expect(chatTitle(null, "992900000000@c.us")).toBe("+992900000000");
    expect(chatTitle(null, "123@lid")).toBe("Клиент WhatsApp");
    expect(chatTitle(" Мадина ", "x")).toBe("Мадина");
  });
});

describe("GET /attention", () => {
  it("groups by chat, newest message first, with plain reason", async () => {
    mocks.prisma.whatsAppInbox.findMany.mockResolvedValue([row({ id: "2", payload: JSON.stringify({ text: "Новое", media: { mimeType: "image/jpeg", data: "SECRET" } }) }), row({ id: "1", createdAt: new Date("2026-11-08T09:00:00Z") })]);
    mocks.prisma.contact.findMany.mockResolvedValue([{ id: "c1", name: "Мадина", humanTakenOverAt: null }]);
    const body = await (await fetch(`${base}/attention`)).json() as { chats: Record<string, unknown>[] };
    expect(mocks.prisma.whatsAppInbox.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "attention", contactId: { not: null } } }));
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0]).toMatchObject({ contactId: "c1", name: "Мадина", lastText: "Новое", kind: "photo", count: 2, reason: attentionText("generation") });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
  it("is empty when nothing needs an answer", async () => {
    mocks.prisma.whatsAppInbox.findMany.mockResolvedValue([]);
    mocks.prisma.contact.findMany.mockResolvedValue([]);
    expect(await (await fetch(`${base}/attention`)).json()).toEqual({ chats: [] });
  });
});

describe("POST /:id/answered", () => {
  it("clears the status and keeps the bot silent in that chat", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue(wa);
    const res = await post("/c1/answered");
    expect(res.status).toBe(200);
    expect(mocks.prisma.whatsAppInbox.updateMany).toHaveBeenCalledWith({ where: { contactId: "c1", status: "attention" }, data: { status: "handled" } });
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { humanTakenOverAt: expect.any(Date) } });
  });
  it("does not move an existing takeover time and rejects non-WhatsApp or unknown chats", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue({ ...wa, humanTakenOverAt: new Date() });
    await post("/c1/answered");
    expect(mocks.prisma.contact.update).not.toHaveBeenCalled();
    mocks.prisma.contact.findUnique.mockResolvedValue({ ...wa, channel: "INSTAGRAM" });
    expect((await post("/c1/answered")).status).toBe(404);
    mocks.prisma.contact.findUnique.mockResolvedValue(null);
    expect((await post("/zzz/answered")).status).toBe(404);
  });
});

describe("POST /:id/return-to-bot", () => {
  it("resets the bridge takeover, clears the status and the pause", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue({ ...wa, humanTakenOverAt: new Date() });
    mocks.prisma.whatsAppInbox.findFirst.mockResolvedValue(row({}));
    expect((await post("/c1/return-to-bot")).status).toBe(200);
    expect(mocks.bridgeRequest).toHaveBeenCalledWith("/takeover/reset", { chatId: "992900000000@c.us" });
    expect(mocks.prisma.whatsAppInbox.updateMany).toHaveBeenCalledWith({ where: { contactId: "c1", status: "attention" }, data: { status: "returned" } });
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { humanTakenOverAt: null, humanTakeoverMid: null, humanSilencedUntil: null } });
  });
  it("keeps the chat in the list when WhatsApp is unreachable", async () => {
    mocks.prisma.contact.findUnique.mockResolvedValue(wa);
    mocks.prisma.whatsAppInbox.findFirst.mockResolvedValue(row({}));
    mocks.bridgeRequest.mockRejectedValue(new Error("down"));
    const res = await post("/c1/return-to-bot");
    expect(res.status).toBe(503);
    expect(mocks.prisma.whatsAppInbox.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.contact.update).not.toHaveBeenCalled();
  });
  it("never re-enables the bot for blocked contacts", async () => {
    for (const flag of [{ personal: true }, { whatsappSavedContact: true }, { spamBlockedAt: new Date() }]) {
      mocks.prisma.contact.findUnique.mockResolvedValue({ ...wa, ...flag });
      expect((await post("/c1/return-to-bot")).status).toBe(409);
    }
    expect(mocks.bridgeRequest).not.toHaveBeenCalled();
    expect(mocks.prisma.contact.update).not.toHaveBeenCalled();
  });
});
