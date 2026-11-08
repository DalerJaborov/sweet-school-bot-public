import { Router, type Request } from "express";
import jwt from "jsonwebtoken";
import { autoCatch } from "./asyncRoute.js";
import { localTodayIso } from "./ai/courseDate.js";
import { adminAccessConfig } from "./adminAccess.js";
import { adminTokenSecret } from "./adminLogin.js";
import {
  OFFER_DEFAULTS,
  STALE_OFFER_MESSAGE,
  checkOffer,
  customOfflineCard,
  offerHistory,
  offerPreview,
  offerVersion,
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
 * Кто сохранил — для журнала. Только из ПРОВЕРЕННОГО входа:
 *  • вход через Cloudflare Access включён — заголовок cf-access-jwt-assertion
 *    уже проверил createAdminAccessGuard (подпись, срок, отзыв), берём почту;
 *  • иначе — админский токен, подпись проверяем здесь тем же секретом, что
 *    requireAuth. Заголовку Access в режиме пароля не верим: его может
 *    подставить кто угодно с паролем и записать в журнал чужое имя.
 * Ничего не распознали — «админ панели».
 */
export function adminActor(req: Request): string {
  if (adminAccessConfig()) {
    const claims = jwt.decode(req.get("cf-access-jwt-assertion") ?? "") as { email?: unknown } | null;
    return typeof claims?.email === "string" ? claims.email.slice(0, 120) : "админ панели";
  }
  const header = req.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return "админ панели";
  try {
    const claims = jwt.verify(header.slice(7), adminTokenSecret(), { algorithms: ["HS256"] }) as {
      role?: unknown;
      via?: unknown;
      tgId?: unknown;
    };
    if (claims.role !== "admin") return "админ панели";
    if (claims.via === "telegram" && (typeof claims.tgId === "number" || typeof claims.tgId === "string"))
      return `Telegram ${claims.tgId}`;
    return "пароль панели";
  } catch {
    return "админ панели";
  }
}

async function snapshot() {
  const [{ offer, legacyHours }, today, custom, history, version] = await Promise.all([
    readOffer(),
    localTodayIso(),
    customOfflineCard(),
    offerHistory(),
    offerVersion(),
  ]);
  const check = checkOffer(offer, offer, today);
  if (legacyHours) check.warnings.push(`Время сейчас записано текстом «${legacyHours}» — укажите часы заново`);
  return {
    offer,
    /** Отпечаток сохранённого — экран возвращает его при сохранении. */
    version,
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
  const result = await saveOffer(req.body?.offer, {
    actor: adminActor(req),
    confirmed: req.body?.confirm === true,
    version: typeof req.body?.version === "string" ? req.body.version : "",
  });
  if (result.status === "stale") {
    res.status(409).json({ error: STALE_OFFER_MESSAGE, stale: true });
    return;
  }
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
