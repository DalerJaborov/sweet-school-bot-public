import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { autoCatch } from "../asyncRoute.js";
import { bridgeRequest, whatsappConfigured, BridgeError } from "./client.js";

/** Mounted AFTER the existing owner authentication, never on a public path. */
export const whatsappAdminRouter = autoCatch(Router());
whatsappAdminRouter.get("/status", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const attention = await prisma.whatsAppInbox.count({ where: { status: "attention" } });
  if (!whatsappConfigured()) { res.json({ state: "not_configured", attention }); return; }
  try { res.json({ ...await bridgeRequest<Record<string, unknown>>("/status"), attention }); }
  catch { res.status(503).json({ error: "Нет связи с WhatsApp", state: "unavailable", attention }); }
});
whatsappAdminRouter.post("/:action", async (req, res) => {
  const action = z.enum(["start", "pause", "resume", "logout"]).safeParse(req.params.action);
  if (!action.success) { res.status(404).json({ error: "Действие не найдено" }); return; }
  try { res.json(await bridgeRequest(`/${action.data}`, {})); }
  catch (e) { res.status(e instanceof BridgeError ? e.status : 503).json({ error: e instanceof Error ? e.message : "WhatsApp недоступен" }); }
});

export const conversationAdminRouter = autoCatch(Router());
conversationAdminRouter.get("/paused", async (_req, res) => {
  res.json(await prisma.contact.findMany({ where: { humanTakenOverAt: { not: null } }, orderBy: { humanTakenOverAt: "desc" }, take: 50,
    select: { id: true, name: true, username: true, channel: true, humanTakenOverAt: true, whatsappSavedContact: true, personal: true } }));
});
conversationAdminRouter.post("/:id/resume", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) { res.status(404).json({ error: "Чат не найден" }); return; }
  if (contact.whatsappSavedContact || contact.personal || contact.spamBlockedAt) { res.status(409).json({ error: "Контакт в списке запретов" }); return; }
  if (contact.channel === "WHATSAPP") {
    const event = await prisma.whatsAppInbox.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
    if (!event) { res.status(409).json({ error: "Нет связанного чата WhatsApp" }); return; }
    await bridgeRequest("/takeover/reset", { chatId: event.chatId });
  }
  await prisma.contact.update({ where: { id: contact.id }, data: { humanTakenOverAt: null, humanTakeoverMid: null, humanSilencedUntil: null } });
  res.json({ ok: true });
});
conversationAdminRouter.post("/:id/block", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact) { res.status(404).json({ error: "Чат не найден" }); return; }
  // Store the local ban first: a broken bridge must not undo the prohibition.
  await prisma.contact.update({ where: { id: contact.id }, data: { personal: true, personalReason: "Запрет автоответов владельцем" } });
  if (contact.channel === "WHATSAPP") {
    const event = await prisma.whatsAppInbox.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
    if (event) await bridgeRequest("/contacts/block", { chatId: event.chatId });
  }
  res.json({ ok: true });
});
