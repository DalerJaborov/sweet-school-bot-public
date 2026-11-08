import crypto from "node:crypto";
import { prisma } from "../db.js";
import { courseTokenSecret } from "./tokenSecret.js";
import { looksLikeShortCode } from "./access.js";
import type { Contact } from "@prisma/client";

/**
 * ПУБЛИЧНЫЙ КОД ПОКУПАТЕЛЬНИЦЫ — «кто я» для бота, когда она пишет не из того чата.
 *
 * ЗАЧЕМ. Покупательница купила через Instagram, а пишет «ссылка не открывается»
 * из WhatsApp с другого номера. По чату бот её не узнаёт. Страница курса может
 * вложить в готовое сообщение WhatsApp код, выведенный из её ссылки /l/<код>.
 *
 * ЧТО ЭТО ЗА КОД. Первые 8 знаков HMAC-SHA256 от кода ссылки с секретом
 * сервера, вид «7F3A-91C2». Сам код ссылки (он и есть ключ входа) из него
 * восстановить нельзя: секрета нет ни у кого, кроме сервера. Поэтому код можно
 * безопасно показывать в переписке: он доказывает только «у человека была
 * ссылка», но входа не даёт.
 *
 * ЧЕГО КОД НЕ ДАЁТ. Он НЕ выдаёт ссылку сам. Совпал с чатом — работает прежний
 * сценарий; не совпал (другой номер/канал) — только сообщение владельцу.
 */

const PURPOSE = "recovery-code-v1:";

/** «7F3A-91C2» из кода ссылки (accessTokenId). */
export function recoveryCodeFor(accessTokenId: string): string {
  const hex = crypto
    .createHmac("sha256", courseTokenSecret())
    .update(PURPOSE + accessTokenId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** Код для показа, только если вход был по короткому коду ссылки. */
export function recoveryCodeForToken(token: string | null | undefined): string | null {
  return token && looksLikeShortCode(token) ? recoveryCodeFor(token) : null;
}

const CODE_IN_TEXT = /(?<![0-9A-Za-z])([0-9A-Fa-f]{4})[-‐-―]([0-9A-Fa-f]{4})(?![0-9A-Za-z])/;

/** Код из присланного текста в каноническом виде или null. */
export function parseRecoveryCode(text: string): string | null {
  const m = CODE_IN_TEXT.exec(text ?? "");
  return m ? `${m[1]}-${m[2]}`.toUpperCase() : null;
}

/**
 * Чья это ссылка. Считаем код у каждого контакта с действующей ссылкой — HMAC
 * стоит микросекунды, а отдельный столбец с кодом потребовал бы миграции и
 * хранения производного секрета в базе.
 */
export async function findContactByRecoveryCode(code: string): Promise<Contact | null> {
  const want = Buffer.from(code);
  const rows = await prisma.contact.findMany({ where: { accessTokenId: { not: null } } });
  for (const row of rows) {
    if (!row.accessTokenId) continue;
    const have = Buffer.from(recoveryCodeFor(row.accessTokenId));
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) return row;
  }
  return null;
}
