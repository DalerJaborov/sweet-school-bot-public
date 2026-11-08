import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { autoCatch } from "../asyncRoute.js";
import { bridgeRequest, whatsappConfigured, BridgeError } from "./client.js";
import { attentionText, chatTitle, describeIncoming } from "./attention.js";

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
/** «Нужен ваш ответ»: по одному элементу на чат, где помощник не смог ответить. */
conversationAdminRouter.get("/attention", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const rows = await prisma.whatsAppInbox.findMany({ where: { status: "attention", contactId: { not: null } }, orderBy: { createdAt: "desc" }, take: 300 });
  const latest = new Map<string, { row: typeof rows[number]; count: number }>();
  for (const row of rows) {
    const seen = latest.get(row.contactId!);
    if (seen) seen.count += 1; else latest.set(row.contactId!, { row, count: 1 });
  }
  const contacts = await prisma.contact.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, name: true, humanTakenOverAt: true } });
  const byId = new Map(contacts.map(c => [c.id, c]));
  res.json({ chats: [...latest.values()].map(({ row, count }) => {
    const incoming = describeIncoming(row.payload);
    return { contactId: row.contactId, name: chatTitle(byId.get(row.contactId!)?.name, row.chatId), lastText: incoming.text, kind: incoming.kind,
      reason: attentionText(row.attentionReason), count, at: row.createdAt.toISOString() };
  }) });
});
conversationAdminRouter.post("/:id/answered", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact || contact.channel !== "WHATSAPP") { res.status(404).json({ error: "Чат не найден" }); return; }
  // Хозяйка ответила сама: помощник в этом чате молчит (та же пауза, что после ручного ответа).
  await prisma.whatsAppInbox.updateMany({ where: { contactId: contact.id, status: "attention" }, data: { status: "handled" } });
  if (!contact.humanTakenOverAt) await prisma.contact.update({ where: { id: contact.id }, data: { humanTakenOverAt: new Date() } });
  res.json({ ok: true });
});
conversationAdminRouter.post("/:id/return-to-bot", async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!contact || contact.channel !== "WHATSAPP") { res.status(404).json({ error: "Чат не найден" }); return; }
  if (contact.whatsappSavedContact || contact.personal || contact.spamBlockedAt) { res.status(409).json({ error: "Этому контакту помощник не отвечает" }); return; }
  const event = await prisma.whatsAppInbox.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
  if (event) {
    try { await bridgeRequest("/takeover/reset", { chatId: event.chatId }); }
    catch { res.status(503).json({ error: "Нет связи с WhatsApp, попробуйте через минуту" }); return; }
  }
  await prisma.whatsAppInbox.updateMany({ where: { contactId: contact.id, status: "attention" }, data: { status: "returned" } });
  await prisma.contact.update({ where: { id: contact.id }, data: { humanTakenOverAt: null, humanTakeoverMid: null, humanSilencedUntil: null } });
  res.json({ ok: true });
});
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
