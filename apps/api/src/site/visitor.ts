import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { courseTokenSecret } from "../course/tokenSecret.js";

/**
 * КУКА ПОСЕТИТЕЛЯ САЙТА — единственное, по чему мы узнаём человека в чате.
 *
 * Входа на сайте нет (и не нужно: человек пришёл спросить про курс, а не
 * регистрироваться). Значит, идентификатор посетителя — это и есть его
 * «аккаунт»: по нему лежит переписка, к нему привязывается чек и ссылка на
 * курс. Подделав чужой идентификатор, можно было бы читать чужую переписку и
 * забрать чужую ссылку. Поэтому значение ПОДПИСАНО: `<24 случайных байта hex>.
 * <HMAC>`, и кука без верной подписи считается отсутствующей — человек просто
 * получает нового посетителя, а не доступ к чужому.
 *
 * Секрет — производный от секрета токенов учениц (course/tokenSecret.ts), по
 * тем же соображениям: новая переменная окружения — это неподнявшийся
 * контейнер при следующем разворачивании.
 */
export const VISITOR_COOKIE = "ssb_visitor";
const TTL_DAYS = 365;
const ID_BYTES = 24;
const PURPOSE = "sweet-school-site-visitor-v1";

function sign(id: string): string {
  return crypto.createHmac("sha256", courseTokenSecret()).update(`${PURPOSE}:${id}`).digest("hex").slice(0, 32);
}

export function issueVisitorId(): string {
  return crypto.randomBytes(ID_BYTES).toString("hex");
}

export function encodeVisitorCookie(id: string): string {
  return `${id}.${sign(id)}`;
}

/** id посетителя из значения куки; null — подписи нет или она не сходится. */
export function decodeVisitorCookie(value: string | null | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[0-9a-f]{48}$/.test(id) || sig.length !== 32) return null;
  const expected = sign(id);
  // Сравнение постоянного времени: подпись — секрет, и по времени ответа её
  // подбирать нельзя даже теоретически.
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function cookieHeader(value: string): string {
  const parts = [`${VISITOR_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_DAYS * 86400}`];
  // Secure только на https — иначе по http на локальной машине кука не сохранится.
  if ((env.publicBaseUrl || "").startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Посетитель этого запроса. Куки нет или она подделана — выпускаем новую и
 * сразу ставим в ответ: контракт обещает куку с первого обращения к /api/site/*.
 * Возвращаем и признак «новый», чтобы /chat/start не искал историю зря.
 */
export function visitorOf(req: Request, res: Response): { id: string; isNew: boolean } {
  const existing = decodeVisitorCookie(readCookie(req, VISITOR_COOKIE));
  if (existing) return { id: existing, isNew: false };
  const id = issueVisitorId();
  res.setHeader("Set-Cookie", cookieHeader(encodeVisitorCookie(id)));
  return { id, isNew: true };
}
