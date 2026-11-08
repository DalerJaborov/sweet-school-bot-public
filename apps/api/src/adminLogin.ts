import crypto from "node:crypto";
import net from "node:net";
import { Router, type Request } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "./env.js";
import { adminAccessConfig } from "./adminAccess.js";
import { clientIp } from "./course/access.js";

/**
 * ВХОД В ПАНЕЛЬ БЕЗ CLOUDFLARE: пароль (браузер) и подпись Telegram (мини-апп, см. miniApp.ts).
 *
 * Админские токены подписываются СВОИМ секретом, выведенным из JWT_SECRET (как токены учениц,
 * course/tokenSecret.ts). Поэтому токены, выданные до перехода на Cloudflare (в том числе утёкшие
 * в инциденте 08.11.2026), после этого релиза не действуют, а ссылки учениц не ломаются.
 * Метку менять нельзя: сменишь — все администраторы выйдут.
 */
const PURPOSE = "sweet-school-admin-tokens-v2";
let cached: string | null = null;
export function adminTokenSecret(): string {
  if (!cached) cached = crypto.createHmac("sha256", env.jwtSecret).update(PURPOSE).digest("hex");
  return cached;
}

export function signAdminToken(extra: Record<string, unknown> = {}): string {
  return jwt.sign({ role: "admin", ...extra }, adminTokenSecret(), { expiresIn: "30d", algorithm: "HS256" });
}

/** Токен должен быть именно админским: подпись админского секрета И роль admin. */
export function isAdminToken(token: string): boolean {
  try {
    const claims = jwt.verify(token, adminTokenSecret(), { algorithms: ["HS256"] }) as { role?: unknown };
    return claims?.role === "admin";
  } catch {
    return false;
  }
}

/** Ключ для счётчика: только настоящий IP, иначе общий ключ. Иначе подделкой заголовка можно
 * завести бесконечно много записей в памяти и обойти счётчик. */
export function limiterKey(req: Request): string {
  const ip = clientIp(req);
  return ip && net.isIP(ip) ? ip : "invalid";
}

const WINDOW_MS = 15 * 60_000;

/**
 * Счётчик НЕУДАЧНЫХ попыток. Верный пароль/подпись в лимит не упирается никогда, а поток
 * неудач с чужого адреса не может запереть владельца: блокируется только этот адрес.
 * Общий потолок неудач защищает память и процессор, и тоже блокирует только неудачников.
 */
export function createFailureGate(perIpLimit: number, maxKeys = 5000) {
  const fails = new Map<string, number[]>();
  const live = (key: string, at: number) => (fails.get(key) ?? []).filter(t => at - t < WINDOW_MS);
  return {
    blocked(key: string, at = Date.now()): boolean {
      return live(key, at).length >= perIpLimit;
    },
    fail(key: string, at = Date.now()): void {
      if (!fails.has(key) && fails.size >= maxKeys) {
        for (const k of fails.keys()) { if (live(k, at).length === 0) fails.delete(k); }
        if (fails.size >= maxKeys) key = "invalid"; // карта полна — копим в общий ключ
      }
      fails.set(key, [...live(key, at), at]);
    },
    reset(): void { fails.clear(); },
  };
}

export const passwordGate = createFailureGate(8);

function samePassword(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const adminLoginRouter = Router();

adminLoginRouter.post("/admin/login", (req, res) => {
  if (adminAccessConfig()) { res.status(403).json({ error: "Используйте защищённый вход" }); return; }
  const key = limiterKey(req);
  if (passwordGate.blocked(key)) {
    res.status(429).json({ error: "Слишком много неверных попыток. Подождите 15 минут или войдите через Telegram." }); return;
  }
  const parsed = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
  if (!parsed.success || !samePassword(parsed.data.password, env.adminPassword)) {
    passwordGate.fail(key);
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }
  res.json({ token: signAdminToken() });
});
