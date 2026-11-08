import { Router, type Response } from "express";
import { z } from "zod";
import { prisma, logInfo } from "../db.js";
import { createRateLimiter } from "../services/rateLimit.js";
import {
  SITE_LANGS,
  SITE_SOURCES,
  SITE_TARGETS,
  SOURCE_LABEL,
  SOURCES_WITH_LABEL,
  TARGET_LABEL,
  createSiteLink,
  listSiteLinks,
  shortUrl,
} from "./siteLinks.js";
import {
  GROUP_KEYS,
  INVITE_PRESETS,
  InviteError,
  botConfigured,
  createPanelInvite,
  groupOptions,
  listPanelInvites,
  removeInviteJoiner,
  revokePanelInvite,
  type InvitePreset,
} from "./telegramInvites.js";

/**
 * API раздела «Ссылки». Монтируется ВНУТРИ adminRouter (admin.ts) — после его
 * проверки входа на всём /admin, поэтому отдельной проверки здесь нет, а
 * публичного пути у этих маршрутов нет вовсе. Публичный — только /go/<код>
 * (siteLinks.ts goRouter), и он не отдаёт ничего, кроме перенаправления.
 */
export const linksAdminRouter = Router();

const BASE = "/admin/v1/links";

// Создание — не чаще 30 раз за 10 минут: ссылка не нужна пачками, а лишние
// вызовы Telegram API упираются в его ограничение частоты.
const createLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });

/** Только для тестов. */
export function resetLinksLimits(): void {
  createLimiter.reset();
}

function limited(res: Response): boolean {
  const verdict = createLimiter.hit("admin");
  if (verdict.ok) return false;
  res.setHeader("Retry-After", String(verdict.retryAfterSec));
  res.status(429).json({ error: "Слишком много ссылок подряд. Подождите несколько минут." });
  return true;
}

linksAdminRouter.use(BASE, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

linksAdminRouter.get(`${BASE}/options`, async (_req, res) => {
  const [groups, bot] = await Promise.all([groupOptions(), botConfigured()]);
  res.json({
    targets: SITE_TARGETS.map((key) => ({ key, label: TARGET_LABEL[key] })),
    sources: SITE_SOURCES.map((key) => ({ key, label: SOURCE_LABEL[key], needsLabel: SOURCES_WITH_LABEL.has(key) })),
    groups,
    presets: (Object.keys(INVITE_PRESETS) as InvitePreset[]).map((key) => ({ key, label: INVITE_PRESETS[key].label })),
    botReady: bot,
  });
});

// ---------- ссылки на сайт ----------

const siteSchema = z
  .object({
    target: z.enum(SITE_TARGETS),
    lang: z.enum(SITE_LANGS),
    source: z.enum(SITE_SOURCES),
    label: z.string().trim().max(60).optional().nullable(),
  })
  .refine((v) => !SOURCES_WITH_LABEL.has(v.source) || Boolean(v.label && v.label.length >= 2), {
    message: "label",
  });

linksAdminRouter.get(`${BASE}/site`, async (_req, res) => {
  res.json({ links: await listSiteLinks() });
});

linksAdminRouter.post(`${BASE}/site`, async (req, res) => {
  const parsed = siteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const needsLabel = parsed.error.issues.some((i) => i.message === "label");
    res.status(400).json({
      error: needsLabel
        ? "Впишите имя блогера или название рекламы (от 2 знаков)."
        : "Выберите, куда ведёт ссылка и откуда придут люди.",
    });
    return;
  }
  if (limited(res)) return;
  const link = await createSiteLink(parsed.data);
  logInfo("links:site", `создана ссылка ${link.code}: ${link.target}/${link.lang} ← ${link.source}`);
  res.status(201).json({ link: { id: link.id, code: link.code, url: shortUrl(link.code) } });
});

// ---------- приглашения в Telegram ----------

const inviteSchema = z.object({
  group: z.enum(GROUP_KEYS),
  preset: z.enum(Object.keys(INVITE_PRESETS) as [InvitePreset, ...InvitePreset[]]),
  name: z.string().trim().max(32).optional().nullable(),
  contactId: z.string().trim().min(1).max(64).optional().nullable(),
});

function inviteFailed(res: Response, err: unknown): void {
  if (!(err instanceof InviteError)) throw err;
  const status = err.reason === "not_found" ? 404 : err.reason === "unavailable" ? 503 : 409;
  res.status(status).json({ error: err.message, reason: err.reason });
}

linksAdminRouter.get(`${BASE}/telegram`, async (_req, res) => {
  res.json({ invites: await listPanelInvites() });
});

linksAdminRouter.post(`${BASE}/telegram`, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Выберите группу и на сколько человек ссылка." });
    return;
  }
  const { contactId } = parsed.data;
  if (contactId && !(await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } }))) {
    res.status(404).json({ error: "Ученица не найдена — обновите страницу." });
    return;
  }
  if (limited(res)) return;
  try {
    const invite = await createPanelInvite(parsed.data);
    res.status(201).json({
      invite: { id: invite.id, link: invite.inviteLink, expiresAt: invite.expiresAt, memberLimit: invite.memberLimit },
    });
  } catch (err) {
    inviteFailed(res, err);
  }
});

linksAdminRouter.post(`${BASE}/telegram/:id/joins/:joinId/remove`, async (req, res) => {
  try {
    await removeInviteJoiner(String(req.params.id), String(req.params.joinId));
    res.json({ ok: true });
  } catch (err) {
    inviteFailed(res, err);
  }
});

linksAdminRouter.post(`${BASE}/telegram/:id/revoke`, async (req, res) => {
  try {
    await revokePanelInvite(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    inviteFailed(res, err);
  }
});
