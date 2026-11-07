import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RequestHandler } from "express";

export function adminAccessConfig(source: NodeJS.ProcessEnv = process.env) {
  if (source.SCHOOL_ACCESS_REQUIRED !== undefined && !["0", "1"].includes(source.SCHOOL_ACCESS_REQUIRED)) {
    throw new Error("SCHOOL_ACCESS_REQUIRED must be 0 or 1");
  }
  if (source.SCHOOL_ACCESS_REQUIRED !== "1") {
    // В бою режим выбирается ЯВНО (0 = пароль и подпись Telegram, 1 = Cloudflare Access):
    // забытая переменная не должна молча сменить способ входа.
    if (source.NODE_ENV === "production" && source.SCHOOL_ACCESS_REQUIRED !== "0") {
      throw new Error("Production admin mode must be explicit: SCHOOL_ACCESS_REQUIRED=0 or 1");
    }
    return null;
  }
  const domain = source.SCHOOL_ACCESS_TEAM_DOMAIN ?? "";
  const audience = source.SCHOOL_ACCESS_AUDIENCE ?? "";
  const email = (source.SCHOOL_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const origins = (source.SCHOOL_ADMIN_ORIGINS ?? "").split(",").map(s => s.trim());
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)
      || !/^[a-f0-9]{64}$/.test(audience) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !origins.length || origins.some(origin => {
        try { const url = new URL(origin); return url.protocol !== "https:" || url.origin !== origin; }
        catch { return true; }
      })) throw new Error("Invalid school Access configuration");
  return { issuer: `https://${domain}`, audience, email, origins };
}

export type AdminAccessConfig = NonNullable<ReturnType<typeof adminAccessConfig>>;
export interface Revocations {
  has(hash: string): Promise<boolean>;
  add(hash: string, expiresAt: Date): Promise<void>;
}

export async function verifyAdminAccess(token: string, config: AdminAccessConfig, keys: JWTVerifyGetKey) {
  if (!token || token.length > 16384) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"], issuer: config.issuer, audience: config.audience,
      requiredClaims: ["exp", "iat", "sub", "email"], maxTokenAge: "1h", clockTolerance: 5,
    });
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string"
        || payload.email.trim().toLowerCase() !== config.email
        || typeof payload.exp !== "number" || typeof payload.iat !== "number"
        || payload.exp - payload.iat > 3600) return null;
    return { email: config.email, expiresAt: new Date(payload.exp * 1000) };
  } catch { return null; }
}

/** Mounted BEFORE all routers, body parsers and CORS on /admin and /admin-form.
 * In Access mode no password, Telegram signature or old application JWT is accepted.
 * Assertions are never returned to the browser, persisted or written to logs.
 */
export function createAdminAccessGuard(config: AdminAccessConfig | null, revocations: Revocations,
  keys?: JWTVerifyGetKey): RequestHandler {
  const jwks = config ? keys ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", config.issuer), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
  }) : undefined;
  return (req, res, next) => {
    if (!config) {
      if (req.baseUrl.toLowerCase() === "/admin" && req.path === "/session" && req.method === "GET") {
        res.json({ mode: "password" }); return;
      }
      next(); return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.baseUrl.toLowerCase() === "/admin-form"
        || /^\/(?:login|telegram-login)\/?$/i.test(req.path)) {
      res.status(403).json({ error: "Вход по паролю и через Telegram отключён. Откройте панель в браузере." }); return;
    }
    if (!["GET", "HEAD"].includes(req.method)
        && (!config.origins.includes(req.get("origin") ?? "") || req.get("sec-fetch-site") === "cross-site")) {
      res.status(403).json({ error: "Запрос должен быть отправлен из панели" }); return;
    }
    const token = req.get("cf-access-jwt-assertion") ?? "";
    void (async () => {
      const session = await verifyAdminAccess(token, config, jwks!);
      if (!session) { res.status(401).json({ error: "Нужен защищённый вход" }); return; }
      const hash = createHash("sha256").update(token).digest("hex");
      if (await revocations.has(hash)) { res.status(401).json({ error: "Сессия завершена. Войдите заново." }); return; }
      res.locals.schoolAccessAuthenticated = true;
      if (req.path === "/session" && req.method === "GET") {
        res.json({ mode: "access", email: session.email }); return;
      }
      if (req.path === "/logout" && req.method === "POST") {
        await revocations.add(hash, session.expiresAt);
        res.json({ ok: true }); return;
      }
      next();
    })().catch(() => {
      // Database/JWKS failures fail closed; never echo credentials or fall back.
      res.status(503).json({ error: "Проверка входа временно недоступна" });
    });
  };
}
