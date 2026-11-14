import type { Contact, Purchase } from "@prisma/client";
import { chatIdFor, type Course } from "../courses.js";
import { getChatMemberStatus } from "../telegram.js";

/**
 * МОЖНО ЛИ ВЫДАТЬ ЧЕЛОВЕКУ ПРИГЛАШЕНИЕ В ГРУППУ — ОДНА ДВЕРЬ (ревью PR 64).
 *
 * Новое приглашение тому, кто уже в группе, — лишняя дверь: его можно переслать
 * подруге. Раньше эта проверка жила только в «Выдать ссылку» (ownerLink.ts), а
 * переход «хочу в Telegram» (channelSwitch.ts) выдавал приглашение всем подряд.
 * Теперь оба пути спрашивают здесь; обход ловит тест groupInviteDoor.test.ts.
 *
 * Как решаем:
 *  - Telegram человека известен — решает сам Telegram (getChatMember): вышла из
 *    группы — можно позвать снова; не ответил — отказ, наугад не выдаём.
 *  - Неизвестен — верим только отметкам входа; а прошлое приглашение без отметки
 *    не даёт понять, вошла ли она, — отказ (unknown-member).
 *
 * Здесь же замок «одна выдача за раз на человека»: «Выдать ссылку», кнопка
 * владельца и переход по просьбе не должны одновременно выпустить две ссылки.
 */

export type InviteCheckFail = "check-failed" | "unknown-member";

export interface InviteCheck {
  /** Куда звать: покупка и чат её группы. */
  targets: { purchase: Purchase; chatId: string }[];
  /** Покупки, по которым человек уже в группе (новое приглашение не нужно). */
  inGroup: Purchase[];
  /** В группе этой покупки человек забанен (kicked): «уже в группе» сказать нельзя, войти он не сможет. */
  banned: Purchase[];
  /** Группа курса не задана в настройках. */
  withoutGroup: Purchase[];
}

/** Статусы, при которых новое приглашение не выдаём. kicked — отдельно (см. banned). */
const MEMBER = new Set(["member", "administrator", "creator", "restricted"]);

export async function checkInviteTargets(
  contact: Pick<Contact, "telegramUserId" | "joinedGroupAt">,
  purchases: Purchase[],
  botToken: string,
): Promise<InviteCheck | { fail: InviteCheckFail }> {
  const result: InviteCheck = { targets: [], inGroup: [], banned: [], withoutGroup: [] };
  const telegramUserId = contact.telegramUserId?.trim() || null;
  // Без Telegram-идентификатора: вход по покупке или по контакту (покупки до него) — уже в группе.
  const candidates = telegramUserId
    ? purchases
    : purchases.filter((p) => !p.joinedAt && (!contact.joinedGroupAt || p.createdAt > contact.joinedGroupAt));
  for (const p of purchases) if (!candidates.includes(p)) result.inGroup.push(p);
  if (!telegramUserId && candidates.some((p) => p.inviteLink?.startsWith("https://t.me/"))) {
    return { fail: "unknown-member" };
  }
  // Прицельная проверка у самого Telegram, пока ни одно приглашение не выпущено.
  for (const p of candidates) {
    const chatId = await chatIdFor(p.course as Course);
    if (!chatId) {
      result.withoutGroup.push(p);
      continue;
    }
    if (telegramUserId) {
      const status = await getChatMemberStatus(botToken, chatId, telegramUserId);
      if (status === null) return { fail: "check-failed" };
      if (MEMBER.has(status)) {
        result.inGroup.push(p);
        continue;
      }
      if (status === "kicked") {
        result.banned.push(p);
        continue;
      }
    }
    result.targets.push({ purchase: p, chatId });
  }
  return result;
}

const busy = new Set<string>();

/** Выполнить выдачу для человека, если по нему сейчас ничего не выдаётся; иначе вернуть `whenBusy`. */
export async function withPersonLock<T>(contactId: string, whenBusy: T, fn: () => Promise<T>): Promise<T> {
  if (busy.has(contactId)) return whenBusy;
  busy.add(contactId);
  try {
    return await fn();
  } finally {
    busy.delete(contactId);
  }
}
