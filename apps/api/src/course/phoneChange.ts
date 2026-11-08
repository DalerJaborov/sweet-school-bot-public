import { prisma, getSetting, logError, logInfo, recordOutgoingMessage } from "../db.js";
import { sendToContact } from "../messaging/send.js";
import { techChatIds, sendTelegramMessage } from "../telegram.js";
import { shouldSendAlert } from "../alertGate.js";
import { canTransferNow, describeDevice, issueMagicLink, transferToNewPhone } from "./access.js";
import { parseRecoveryCode, recoveryCodeFor } from "./linkCode.js";
import type { Contact } from "@prisma/client";
import { ACCEPTED_WHERE } from "../receiptAccepted.js";

/**
 * СМЕНА ТЕЛЕФОНА — только через бота (владелец 08.11.2026).
 *
 * Курс открывается на одном телефоне. На втором телефоне экран курса не даёт
 * никакой кнопки «перенести»: там написано, что для другого телефона нужно
 * купить курс. Настоящая смена телефона («купила новый») идёт в чате, где
 * куплен курс, и бот делает её сам ТОЛЬКО при доказательстве по данным в базе:
 *  - код из её ссылки (вид 7F3A-91C2, linkCode.ts), либо
 *  - чек картинкой: тот же файл, что уже подтверждён по её контакту, либо
 *  - имя и номер телефона, совпавшие с тем, что известно по её покупке.
 * Совпало и в этом месяце переноса ещё не было: старые устройства удаляются,
 * старая ссылка перестаёт открываться, уходит новая. Не совпало или перенос в
 * месяце уже был: «передала Ширин» и владельцу карточка с кнопкой
 * «Разрешить перенос».
 *
 * Чек здесь только доказательство личности: в оплату он не засчитывается, доступ
 * по нему повторно не выдаётся, разбор чеков (receiptVerdict) не меняется.
 */

/** Карточка владельцу живёт сутки и срабатывает один раз (старая и повторное нажатие не меняют ссылку). */
const APPROVAL_TTL_MS = 24 * 3_600_000;
const approvals = new Map<string, number>();

/** Только для тестов: сбросить запомненные карточки и ожидания. */
export function resetPhoneChangeState(): void {
  approvals.clear();
  awaiting.clear();
}

const awaiting = new Map<string, number>();
export function isAwaitingProof(contactId: string): boolean {
  const until = awaiting.get(contactId);
  if (!until) return false;
  if (until < Date.now()) {
    awaiting.delete(contactId);
    return false;
  }
  return true;
}

export type ProofKind = "link_code" | "receipt" | "name_phone" | "own_chat";
export type PhoneChangeOutcome = "changed" | "no_proof" | "limit" | "send_failed" | "no_link" | "blocked";

type Lang = "ru" | "tg" | "en";

export const PHONE_CHANGE_TEXT: Record<Lang, { changed: string; noProof: string; limit: string; approved: string; failed: string }> = {
  ru: {
    changed:
      "Перенесла доступ на новый телефон. Вот новая ссылка, откройте её на нём. " +
      "Прежняя ссылка и старый телефон больше не открывают уроки:\n",
    noProof:
      "Чтобы я перенесла доступ на новый телефон сама, пришлите чек об оплате картинкой или код из вашей ссылки (вид 7F3A-91C2). " +
      "Пока передала Ширин: она посмотрит и ответит вам.",
    limit:
      "Передала Ширин: она посмотрит и ответит вам.",
    approved:
      "Ширин разрешила перенос на новый телефон. Вот новая ссылка, откройте её на нём. " +
      "Прежняя ссылка и старый телефон больше не открывают уроки:\n",
    failed: "Передала Ширин: она посмотрит и ответит вам.",
  },
  tg: {
    changed:
      "Дастрасиро ба телефони нав гузарондам. Ана ссылкаи нав, дар телефони нав кушоен. " +
      "Ссылкаи пешина ва телефони куханатон дигар дарсхоя намекушояд:\n",
    noProof:
      "Барои ки худам ба телефони нав гузаронам, сурати чеки пардохт ё коди ссылкаатона (мисли 7F3A-91C2) фиристен. " +
      "Хозир ба Ширин гуфтам, тафтиш карда худаш чавоб медихад.",
    limit:
      "Ба Ширин гуфтам, тафтиш карда худаш чавоб медихад.",
    approved:
      "Ширин ичозат дод, ба телефони нав гузарондам. Ана ссылкаи нав, дар телефони нав кушоен. " +
      "Ссылкаи пешина ва телефони куханатон дигар дарсхоя намекушояд:\n",
    failed: "Ба Ширин гуфтам, тафтиш карда худаш чавоб медихад.",
  },
  en: {
    changed:
      "I moved your access to the new phone. Here is the new link, open it there. The old link and the old phone no longer open the lessons:\n",
    noProof:
      "To move access myself, send the payment receipt as a picture or the code from your link (like 7F3A-91C2). For now I passed this to Shirin.",
    limit: "I passed this to Shirin, she will look and reply.",
    approved:
      "Shirin approved the move. Here is the new link, open it on the new phone. The old link and phone no longer work:\n",
    failed: "I passed this to Shirin, she will look and reply.",
  },
};

function lang(contact: Contact): Lang {
  return contact.preferredLanguage === "tg" ? "tg" : "ru";
}

/** Последние 9 цифр: «+992 900 12-34-56» и «900123456» — один и тот же номер. */
function phoneKey(raw: string): string {
  return raw.replace(/\D/g, "").slice(-9);
}

/** Номера из текста сообщения (не короче 9 цифр). */
function phonesInText(text: string): string[] {
  const found = text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? [];
  return found.map(phoneKey).filter((p) => p.length === 9);
}

function nameMatches(known: string | null | undefined, text: string): boolean {
  const words = (known ?? "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);
  const lower = text.toLowerCase();
  return words.length > 0 && words.some((w) => lower.includes(w));
}

/**
 * Доказательство, что пишет та самая покупательница. Только по данным в базе;
 * слова «я платила» не считаются. Возвращает вид доказательства или null.
 * Чек: ТОЛЬКО чтение, запись о чеке не создаётся и не меняется.
 */
export async function phoneChangeProof(
  contact: Contact,
  text: string,
  imageHashes: string[] = [],
): Promise<ProofKind | null> {
  // 1. Код из её ссылки (производный от кода ссылки, секрет сервера).
  const code = parseRecoveryCode(text);
  if (code && contact.accessTokenId && code === recoveryCodeFor(contact.accessTokenId)) return "link_code";

  // 2. Чек картинкой: тот же файл, что уже принят по ЭТОМУ контакту.
  if (imageHashes.length > 0) {
    const mine = await prisma.receiptCheck.count({
      where: {
        contactId: contact.id,
        imageHash: { in: imageHashes },
        OR: ACCEPTED_WHERE,
      },
    });
    if (mine > 0) return "receipt";
  }

  // 3. Имя и телефон покупки: оба должны совпасть с тем, что у нас записано.
  const phones = phonesInText(text);
  if (phones.length > 0) {
    const signups = await prisma.offlineSignup.findMany({ where: { contactId: contact.id } }).catch(() => []);
    const knownPhones = new Set<string>(signups.map((s) => phoneKey(s.phone)));
    if (contact.channel === "WHATSAPP") knownPhones.add(phoneKey(contact.igUserId));
    const knownNames = [contact.name, ...signups.map((s) => s.name)];
    if (phones.some((p) => knownPhones.has(p)) && knownNames.some((n) => nameMatches(n, text))) return "name_phone";
  }
  return null;
}

/**
 * Само перенос: новая ссылка записывается, уходит человеку, и только после
 * доставки удаляются устройства. Не доставилась — прежняя ссылка возвращается,
 * чтобы покупательница не осталась ни с чем. Лимит и доказательство проверяет
 * вызывающий (бот) либо владелец (кнопка).
 */
export async function performPhoneChange(
  contact: Contact,
  kind: "bot" | "owner",
  opts: { ignoreLimit?: boolean; proof?: string } = {},
): Promise<"changed" | "send_failed" | "no_link" | "blocked"> {
  const fresh = await prisma.contact.findUnique({ where: { id: contact.id } });
  if (!fresh || fresh.accessRevokedAt || fresh.spamBlockedAt) return "no_link";
  const { url, jti } = issueMagicLink(fresh.id);
  if (!url.startsWith("http")) return "no_link";
  // Заблокированное устройство тоже занимает единственное место, но блокировка
  // выше переноса: ни бот, ни кнопка владельца его не снимают. Сначала
  // владелец разблокирует устройство в панели.
  if ((await prisma.device.count({ where: { contactId: fresh.id, blockedAt: { not: null } } })) > 0) {
    return "blocked";
  }
  const claimed = await prisma.contact.updateMany({
    where: {
      id: fresh.id,
      accessTokenId: fresh.accessTokenId ?? null,
      accessIssuedAt: fresh.accessIssuedAt ?? null,
      accessRevokedAt: null,
      spamBlockedAt: null,
    },
    data: { accessTokenId: jti, accessIssuedAt: new Date() },
  });
  if (claimed.count !== 1) return "send_failed";

  const restoreLink = () =>
    prisma.contact
      .updateMany({
        where: { id: fresh.id, accessTokenId: jti },
        data: { accessTokenId: fresh.accessTokenId ?? null, accessIssuedAt: fresh.accessIssuedAt ?? null },
      })
      .catch((err) => logError("phoneChange:restoreLink", err));

  // Устройства и счётчик — одной транзакцией ДО отправки ссылки (владелец
  // 08.11.2026). Сбой — ссылка возвращается, владельцу тревога. Лимит владелец
  // снимает только на этот перенос.
  const forTransfer = opts.ignoreLimit ? ({ ...fresh, deviceSwaps: 0, deviceSwapAt: null } as Contact) : fresh;
  let result: "transferred" | "nothing" | "limit";
  try {
    result = await transferToNewPhone(forTransfer, false, kind === "owner" ? "owner" : "bot");
  } catch (err) {
    logError("phoneChange:transfer", err);
    await restoreLink();
    await notifyOwner(fresh, "перенос на новый телефон не удался (устройства не сняты, прежняя ссылка возвращена): сделайте вручную");
    return "send_failed";
  }

  const text = (kind === "owner" ? PHONE_CHANGE_TEXT[lang(fresh)].approved : PHONE_CHANGE_TEXT[lang(fresh)].changed) + url;
  let delivered = false;
  try {
    // Нажатие владельца — его решение: пауза бота и «ответила Ширин сама» не мешают.
    const mid = await sendToContact(fresh, text, [], kind === "owner" ? { byHuman: true } : {});
    if (mid) {
      await recordOutgoingMessage(fresh.id, text, mid);
      delivered = true;
    }
  } catch (err) {
    logError("phoneChange:send", err);
  }
  if (!delivered) {
    // Прежняя ссылка возвращается (если её никто не заменил), месячный перенос не тратится.
    await restoreLink();
    if (result === "transferred") {
      await prisma.contact
        .update({ where: { id: fresh.id }, data: { deviceSwaps: fresh.deviceSwaps, deviceSwapAt: fresh.deviceSwapAt } })
        .catch((err) => logError("phoneChange:restoreCounter", err));
      await notifyOwner(fresh, "старые устройства сняты, но ссылка не доставлена: прежняя ссылка возвращена, она может открыть курс на новом телефоне");
    }
    return "send_failed";
  }
  logInfo("course:phoneChange", `контакт ${fresh.id}: смена телефона (${kind}), доказательство: ${opts.proof ?? "решение владельца"}, устройства: ${result}`);
  return "changed";
}

async function replyTo(contact: Contact, text: string): Promise<void> {
  try {
    const mid = await sendToContact(contact, text);
    if (mid) await recordOutgoingMessage(contact.id, text, mid);
  } catch (err) {
    logError("phoneChange:reply", err);
  }
}

/**
 * Просьба сменить телефон из чата. Решает по доказательству и месячному лимиту.
 * Что деньги видны в базе, проверяет вызывающий (recovery.ts).
 */
export async function handlePhoneChange(
  contact: Contact,
  text: string,
  language: Lang,
  imageHashes: string[] = [],
): Promise<PhoneChangeOutcome> {
  // Покупательница с сайта (чат WEB): правило PR 62 — бот сам ссылку не переносит,
  // решает владелец одним нажатием.
  if (contact.channel === "WEB") {
    await replyTo(contact, PHONE_CHANGE_TEXT[language].failed);
    await askOwner(contact, "покупательница с сайта просит сменить телефон", "web");
    return "no_link";
  }
  // Решение владельца 08.11.2026: сообщение из ЕЁ ЖЕ чата покупки с подтверждённой
  // оплатой (проверяет recovery.ts) — уже доказательство: ссылка приходит только
  // туда. Код, чек и имя с номером — дополнительные, пишутся в журнал.
  const proof: ProofKind = (await phoneChangeProof(contact, text, imageHashes)) ?? "own_chat";
  if (!canTransferNow(contact)) {
    await replyTo(contact, PHONE_CHANGE_TEXT[language].limit);
    await askOwner(contact, `просит сменить телефон ещё раз в этом месяце (доказательство: ${PROOF_NAME[proof]})`);
    return "limit";
  }
  awaiting.delete(contact.id);
  const done = await performPhoneChange(contact, "bot", { proof: PROOF_NAME[proof] });
  if (done === "changed") {
    await notifyOwner(contact, `бот перенёс доступ на новый телефон (доказательство: ${PROOF_NAME[proof]})`);
    return "changed";
  }
  await replyTo(contact, PHONE_CHANGE_TEXT[language].failed);
  await askOwner(
    contact,
    done === "blocked"
      ? "доказательство есть, но её устройство заблокировано: сначала разблокируйте его в панели"
      : "доказательство есть, но ссылку на новый телефон отправить не удалось",
    "failed",
  );
  return done;
}

const PROOF_NAME: Record<ProofKind, string> = {
  link_code: "код из ссылки",
  receipt: "её чек картинкой",
  name_phone: "имя и телефон покупки",
  own_chat: "сообщение из её чата покупки",
};

async function ownerChat(): Promise<{ botToken: string; chatId: string } | null> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0];
  return botToken && chatId ? { botToken, chatId } : null;
}

function who(contact: Contact): string {
  return [contact.name, contact.username ? `@${contact.username}` : null, `${contact.channel} ${contact.igUserId}`]
    .filter(Boolean)
    .join(", ");
}

async function devicesNow(contactId: string): Promise<string> {
  const devices = await prisma.device.findMany({ where: { contactId } }).catch(() => []);
  return (
    devices
      .map(
        (d) =>
          `${describeDevice(d.userAgent)}${d.lastCity ? `, ${d.lastCity}` : ""}, в сети ${d.lastSeenAt.toISOString().slice(0, 10)}`,
      )
      .join("; ") || "нет данных"
  );
}

/** Карточка владельцу с кнопкой «Разрешить перенос». */
async function askOwner(contact: Contact, what: string, key = "ask"): Promise<void> {
  const chat = await ownerChat();
  if (!chat) return;
  if (!(await shouldSendAlert(`phone-change:${key}:${contact.id}`, { cooldownMs: 12 * 3_600_000 }))) return;
  approvals.set(contact.id, Date.now() + APPROVAL_TTL_MS);
  const last = contact.deviceSwapAt ? contact.deviceSwapAt.toISOString().slice(0, 10) : "переносов не было";
  await sendTelegramMessage(
    chat.botToken,
    chat.chatId,
    `${who(contact)}: ${what}. Прошлый перенос: ${last}. Сейчас занято: ${await devicesNow(contact.id)}. ` +
      "Если это она, нажмите «Разрешить перенос»: старый телефон и старая ссылка перестанут работать, новая уйдёт ей в чат.",
    undefined,
    { inline_keyboard: [[{ text: "Разрешить перенос", callback_data: `mn:tr:${contact.id}` }]] },
  ).catch((err) => logError("phoneChange:askOwner", err));
}

async function notifyOwner(contact: Contact, what: string): Promise<void> {
  const chat = await ownerChat();
  if (!chat) return;
  await sendTelegramMessage(chat.botToken, chat.chatId, `${who(contact)}: ${what}`).catch((err) =>
    logError("phoneChange:notifyOwner", err),
  );
}

/**
 * Владелец нажал «Разрешить перенос»: месячный лимит снимается и перенос
 * делается сразу (новая ссылка в чат, старые устройства и ссылка аннулируются).
 */
export async function approveTransferByOwner(contactId: string): Promise<"ok" | "expired" | "blocked" | "failed"> {
  // Проверка и погашение карточки — БЕЗ await между ними: два одновременных
  // нажатия не пройдут оба.
  const until = approvals.get(contactId);
  approvals.delete(contactId);
  if (!until || until < Date.now()) return "expired";
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return "failed";
  const done = await performPhoneChange(contact, "owner", { ignoreLimit: true });
  logInfo("course:phoneChange", `контакт ${contactId}: владелец разрешил перенос, итог ${done}`);
  if (done === "changed") return "ok";
  // Заново взводим только когда ничего не менялось из-за блокировки: сначала
  // владелец разблокирует. После сбоя отправки карточка не оживает (другой
  // перенос мог идти параллельно): новая придёт, когда она напишет снова.
  if (done === "blocked") approvals.set(contactId, until);
  return done === "blocked" ? "blocked" : "failed";
}
