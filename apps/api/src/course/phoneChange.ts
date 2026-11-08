import crypto from "node:crypto";
import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { techChatIds, sendTelegramMessage } from "../telegram.js";
import { shouldSendAlert } from "../alertGate.js";
import { canTransferNow, describeDevice } from "./access.js";
import type { Contact } from "@prisma/client";

/**
 * ПЕРЕНОС НА НОВЫЙ ТЕЛЕФОН ПО КОДУ (владелец 08.11.2026).
 *
 * Покупательница нажимает «Перенести» на втором телефоне; код подтверждения
 * уходит в ЕЁ чат с ботом (тот, где она купила курс: WhatsApp, Instagram), а не
 * на тот телефон, где она сидит. Ввела код — старый телефон аннулируется, новый
 * открывается. Это и есть доказательство, что у неё есть доступ к чату покупки.
 *
 * Код живёт в памяти процесса: 6 цифр, хранится только хэш, 10 минут, 5 попыток,
 * новый код не чаще раза в минуту и не больше 5 в час. Перезапуск сервера
 * просто сбрасывает неподтверждённые коды — человек запросит новый.
 */

const CODE_TTL_MS = 10 * 60_000;
const RESEND_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;

type Pending = { hash: string; exp: number; attempts: number; sentAt: number; sends: number[] };
const pending = new Map<string, Pending>();

function hashCode(contactId: string, code: string): string {
  return crypto.createHash("sha256").update(`${contactId}:${code}`).digest("hex");
}

export type RequestResult = "sent" | "cooldown" | "owner_asked" | "send_failed";

const TEXT = {
  ru: (code: string) =>
    `Код для переноса курса на новый телефон: ${code}. Никому его не сообщайте. Он действует 10 минут. ` +
    "Если это не вы, просто проигнорируйте сообщение.",
  tg: (code: string) =>
    `Рамз барои гузаронидани курс ба телефони нав: ${code}. Онро ба ҳеҷ кас нагӯед. Он 10 дақиқа амал мекунад. ` +
    "Агар ин шумо набошед, паёмро нодида гиред.",
};
const APPROVED = {
  ru: "Перенос на новый телефон разрешён. Нажмите «Перенести» в курсе ещё раз, и вам придёт код.",
  tg: "Гузариш ба телефони нав иҷозат дода шуд. Дар курс боз «Гузаронидан»-ро пахш кунед, рамз меояд.",
};

function lang(contact: Contact): "ru" | "tg" {
  return contact.preferredLanguage === "tg" ? "tg" : "ru";
}

export async function requestTransferCode(contact: Contact): Promise<RequestResult> {
  // Перенос в этом месяце уже был: код не шлём, спрашиваем владельца.
  if (!canTransferNow(contact)) {
    await askOwnerToAllow(contact);
    return "owner_asked";
  }
  const now = Date.now();
  const cur = pending.get(contact.id);
  const sends = (cur?.sends ?? []).filter((t) => now - t < 3_600_000);
  if (cur && now - cur.sentAt < RESEND_MS) return "cooldown";
  if (sends.length >= MAX_SENDS_PER_HOUR) return "cooldown";

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const text = TEXT[lang(contact)](code);
  let ok = false;
  try {
    const mid = await sendToContact(contact, text);
    if (mid) {
      await recordOutgoingMessage(contact.id, "[код переноса отправлен]", mid);
      ok = true;
    }
  } catch (err) {
    logError("phoneTransfer:send", err);
  }
  if (!ok) {
    await tellOwner(contact, "не получилось отправить код переноса в её чат", false);
    return "send_failed";
  }
  pending.set(contact.id, {
    hash: hashCode(contact.id, code),
    exp: now + CODE_TTL_MS,
    attempts: 0,
    sentAt: now,
    sends: [...sends, now],
  });
  return "sent";
}

/** true — код верный (и сгорает); иначе false. */
export function verifyTransferCode(contactId: string, code: string): boolean {
  const cur = pending.get(contactId);
  if (!cur || Date.now() > cur.exp || cur.attempts >= MAX_ATTEMPTS) return false;
  cur.attempts += 1;
  const want = Buffer.from(cur.hash);
  const have = Buffer.from(hashCode(contactId, code.trim()));
  const ok = want.length === have.length && crypto.timingSafeEqual(want, have);
  if (ok) pending.delete(contactId);
  return ok;
}

/** Только для тестов. */
export function resetTransferCodes(): void {
  pending.clear();
}

async function askOwnerToAllow(contact: Contact): Promise<void> {
  const last = contact.deviceSwapAt ? contact.deviceSwapAt.toISOString().slice(0, 10) : "дата неизвестна";
  const devices = await prisma.device.findMany({ where: { contactId: contact.id } }).catch(() => []);
  const now = devices
    .map(
      (d) =>
        `${describeDevice(d.userAgent)}${d.lastCity ? `, ${d.lastCity}` : ""}, в сети ${d.lastSeenAt.toISOString().slice(0, 10)}`,
    )
    .join("; ");
  await tellOwner(
    contact,
    `просит перенос на новый телефон ещё раз в этом месяце (прошлый перенос ${last}). Сейчас занято: ${now || "нет данных"}. ` +
      "Если это она, нажмите «Разрешить перенос»",
    true,
  );
}

async function tellOwner(contact: Contact, what: string, withButton: boolean): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0];
  if (!botToken || !chatId) return;
  if (!(await shouldSendAlert(`transfer:${contact.id}`, { cooldownMs: 12 * 3_600_000 }))) return;
  const who = [contact.name, contact.username ? `@${contact.username}` : null, `${contact.channel} ${contact.igUserId}`]
    .filter(Boolean)
    .join(", ");
  await sendTelegramMessage(
    botToken,
    chatId,
    `${who}: ${what}`,
    undefined,
    withButton
      ? { inline_keyboard: [[{ text: "Разрешить перенос", callback_data: `mn:tr:${contact.id}` }]] }
      : undefined,
  ).catch((err) => logError("phoneTransfer:tellOwner", err));
}

/** Владелец нажал «Разрешить перенос»: снимаем месячный лимит и пишем покупательнице. */
export async function approveTransferByOwner(contactId: string): Promise<boolean> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return false;
  await prisma.contact.update({ where: { id: contactId }, data: { deviceSwaps: 0, deviceSwapAt: null } });
  logInfo("course:deviceSwap", `контакт ${contactId}: владелец разрешил перенос`);
  try {
    const text = APPROVED[lang(contact)];
    const mid = await sendToContact(contact, text);
    if (mid) await recordOutgoingMessage(contact.id, text, mid);
  } catch (err) {
    logError("phoneTransfer:approvedNotice", err);
  }
  return true;
}
