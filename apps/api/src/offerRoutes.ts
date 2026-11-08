import { Router, type Request } from "express";
import jwt from "jsonwebtoken";
import { autoCatch } from "./asyncRoute.js";
import { localTodayIso } from "./ai/courseDate.js";
import {
  OFFER_DEFAULTS,
  checkOffer,
  customOfflineCard,
  offerHistory,
  offerPreview,
  parseOffer,
  readOffer,
  saveOffer,
} from "./services/offerService.js";

/**
 * РАЗДЕЛ «ЦЕНЫ И ДАТЫ» — /admin/v1/offer (08.11.2026).
 *
 * Тонкий HTTP-слой над services/offerService.ts: вся логика (проверки,
 * подтверждение, журнал, сброс кэшей) — там, чтобы экран, бот и будущий
 * мобильный клиент ходили через одну дверь. Монтируется в adminRouter, вход
 * уже проверен выше (requireAuth), как у остальных /admin/*.
 */
export const offerRouter = autoCatch(Router());

/**
 * Кто сохранил — для журнала. Подпись уже проверена requireAuth (Access или
 * админский токен), здесь только читаем, ЧЬЯ она. Ничего не проверяем заново и
 * ничего не доверяем сверх этого: строка идёт только в журнал.
 */
export function adminActor(req: Request): string {
  const access = req.get("cf-access-jwt-assertion");
  if (access) {
    const claims = jwt.decode(access) as { email?: unknown } | null;
    if (typeof claims?.email === "string") return claims.email;
    return "защищённый вход";
  }
  const header = req.get("authorization") ?? "";
  const claims = header.startsWith("Bearer ")
    ? (jwt.decode(header.slice(7)) as { via?: unknown; tgId?: unknown } | null)
    : null;
  if (claims?.via === "telegram" && (typeof claims.tgId === "number" || typeof claims.tgId === "string"))
    return `Telegram ${claims.tgId}`;
  return "пароль панели";
}

async function snapshot() {
  const [{ offer, legacyHours }, today, custom, history] = await Promise.all([
    readOffer(),
    localTodayIso(),
    customOfflineCard(),
    offerHistory(),
  ]);
  const check = checkOffer(offer, offer, today);
  if (legacyHours) check.warnings.push(`Время сейчас записано текстом «${legacyHours}» — укажите часы заново`);
  return {
    offer,
    defaults: OFFER_DEFAULTS,
    today,
    preview: offerPreview(offer, today, custom),
    warnings: check.warnings,
    history,
  };
}

offerRouter.get("/admin/v1/offer", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await snapshot());
});

/** Предпросмотр и проверка черновика — ничего не пишет. */
offerRouter.post("/admin/v1/offer/preview", async (req, res) => {
  const parsed = parseOffer(req.body?.offer);
  if ("errors" in parsed) {
    res.status(400).json({ error: "Проверьте поля", fields: parsed.errors });
    return;
  }
  const [{ offer: before }, today, custom] = await Promise.all([readOffer(), localTodayIso(), customOfflineCard()]);
  res.json({ preview: offerPreview(parsed.offer, today, custom), check: checkOffer(before, parsed.offer, today) });
});

offerRouter.put("/admin/v1/offer", async (req, res) => {
  const result = await saveOffer(req.body?.offer, { actor: adminActor(req), confirmed: req.body?.confirm === true });
  if (result.status === "invalid") {
    res.status(400).json({ error: "Проверьте поля", fields: result.errors });
    return;
  }
  if (result.status === "confirm") {
    res.status(409).json({ error: "Цена меняется сильно — подтвердите", confirm: result.confirm });
    return;
  }
  res.json({ ok: true, changes: result.changes.length, ...(await snapshot()) });
});
