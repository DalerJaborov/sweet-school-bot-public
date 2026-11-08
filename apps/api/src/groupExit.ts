import type { Contact, Purchase } from "@prisma/client";
import { prisma, getSetting, logError, logInfo } from "./db.js";
import { techChatIds, sendTelegramMessage } from "./telegram.js";
import { shouldSendAlert } from "./alertGate.js";
import { chatIdFor, type Course } from "./courses.js";

/**
 * ЕДИНСТВЕННАЯ ДВЕРЬ «УДАЛИТЬ ЧЕЛОВЕКА ИЗ TELEGRAM-ГРУППЫ» (08.11.2026).
 *
 * Выгоняют из группы три пути: «отобрать доступ» (groupAccess.revokeAccess),
 * кнопка «Удалить» у вошедшего по ссылке из панели (links/telegramInvites) и
 * переход на сайт (course/channelSwitch). Раньше у каждого был свой цикл
 * бан/разбан, и в каждом чего-то не хватало: проверки админа, повтора, журнала.
 * Теперь бан и разбан живут только здесь; обход ловит тест groupExitDoor.test.ts.
 *
 * ПРАВИЛА:
 *  - Перед баном getChatMember: администраторов и создателя не трогаем (бот и не
 *    сможет, а попытка шумит и может сломать чужие права).
 *  - Бан сразу снимается (only_if_banned): человек выгнан, но вернуться может по
 *    новому приглашению. Если разбан не прошёл — человек остался в чёрном списке
 *    навсегда, это ПРОБЛЕМА: повторяем и зовём хозяйку.
 *  - Бан только в группах курсов, купленных ЭТИМ контактом, и не там, где у
 *    другого контакта с тем же Telegram есть действующая покупка.
 *  - Каждое удаление пишется в журнал (AccessEvent «removed»), отметки «в группе»
 *    сбрасываются.
 */

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;
const BAN_ATTEMPTS = 2;
const UNBAN_ATTEMPTS = 3;

export type ExitState = "removed" | "absent" | "protected" | "ban_failed" | "unban_failed";
export interface ExitResult {
  chatId: string;
  state: ExitState;
  detail?: string;
}

type Reply = { ok: boolean; description?: string; result?: unknown };

async function api(botToken: string, method: string, body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch(`${API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json()) as Reply;
    return { ok: Boolean(data.ok), description: data.description, result: data.result };
  } catch (err) {
    logError(`groupExit:${method}`, err);
    return { ok: false, description: String(err) };
  }
}

/**
 * Удалить человека из ОДНОГО чата: проверка, бан, немедленный разбан.
 * Не пишет в базу и никому не сообщает — это делают вызывающие.
 */
export async function removeFromGroupChat(
  botToken: string,
  chatId: string,
  telegramUserId: string,
): Promise<ExitResult> {
  const userId = Number(telegramUserId);
  if (!Number.isFinite(userId) || userId === 0) {
    return { chatId, state: "ban_failed", detail: "неверный Telegram-идентификатор" };
  }

  const member = await api(botToken, "getChatMember", { chat_id: chatId, user_id: userId });
  if (member.ok) {
    const status = (member.result as { status?: string } | undefined)?.status;
    if (status === "administrator" || status === "creator") return { chatId, state: "protected" };
    if (status === "left" || status === "kicked") return { chatId, state: "absent" };
  } else if (/user not found|participant_id_invalid/i.test(member.description ?? "")) {
    return { chatId, state: "absent" };
  } else {
    // Не смогли узнать, кто это: вслепую не баним (вдруг админ).
    return { chatId, state: "ban_failed", detail: member.description ?? "getChatMember не ответил" };
  }

  let ban: Reply = { ok: false };
  for (let i = 0; i < BAN_ATTEMPTS && !ban.ok; i++) {
    ban = await api(botToken, "banChatMember", { chat_id: chatId, user_id: userId });
  }
  if (!ban.ok) return { chatId, state: "ban_failed", detail: ban.description };

  let unban: Reply = { ok: false };
  for (let i = 0; i < UNBAN_ATTEMPTS && !unban.ok; i++) {
    unban = await api(botToken, "unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
  }
  if (!unban.ok) {
    logError("groupExit:unban", new Error(`${chatId}/${telegramUserId}: ${unban.description}`));
    return { chatId, state: "unban_failed", detail: unban.description };
  }
  return { chatId, state: "removed" };
}

/** Человек, по нашим данным, сейчас в группе (по отметкам входа). */
export function isInGroup(
  contact: Pick<Contact, "joinedGroupAt">,
  purchases: Pick<Purchase, "joinedAt">[],
): boolean {
  return Boolean(contact.joinedGroupAt) || purchases.some((p) => p.joinedAt);
}

export interface GroupExitReport {
  results: ExitResult[];
  /** Простыми словами: что не получилось (для хозяйки). Пусто — всё прошло. */
  problems: string[];
}

async function courseChatIds(purchases: Pick<Purchase, "course">[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const p of purchases) {
    const id = await chatIdFor(p.course as Course);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Убрать контакт из групп купленных им курсов. `purchases` — те покупки, чьи
 * группы закрываем. Возвращает отчёт; сообщение хозяйке шлёт вызывающий
 * (одно на весь случай), через alertOwnerProblem.
 */
export async function removeContactFromGroups(
  contact: Pick<Contact, "id" | "telegramUserId" | "joinedGroupAt">,
  purchases: Purchase[],
  actor: "owner" | "bot",
): Promise<GroupExitReport> {
  const report: GroupExitReport = { results: [], problems: [] };
  const wasIn = isInGroup(contact, purchases);
  const telegramUserId = contact.telegramUserId?.trim();
  if (!telegramUserId) {
    if (wasIn) report.problems.push("из группы не удалена: Telegram-идентификатор неизвестен, уберите её вручную");
    return report;
  }
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) {
    report.problems.push("из группы не удалена: не задан маркер Telegram-бота");
    return report;
  }

  // Чаты, где этот же Telegram держит другой контакт с действующей покупкой, не трогаем.
  const others = await prisma.purchase.findMany({
    where: { revokedAt: null, contact: { telegramUserId, id: { not: contact.id } } },
    select: { course: true },
  });
  const keep = new Set(await courseChatIds(others ?? []));

  for (const chatId of await courseChatIds(purchases)) {
    if (keep.has(chatId)) {
      logInfo("groupExit", `контакт ${contact.id}: чат ${chatId} оставлен, у того же Telegram есть другая покупка`);
      continue;
    }
    const result = await removeFromGroupChat(botToken, chatId, telegramUserId);
    report.results.push(result);
    if (result.state === "removed") await recordRemoval(contact.id, chatId, telegramUserId, actor);
    else if (result.state === "ban_failed")
      report.problems.push(`из группы убрать не удалось (${result.detail ?? "ошибка Telegram"})`);
    else if (result.state === "protected") report.problems.push("она администратор группы, бот её не удалял");
    else if (result.state === "unban_failed")
      report.problems.push("её удалили, но снять бан не вышло: вернуться она не сможет, разбаньте вручную");
  }

  // Отметки «в группе» сбрасываем, только если ни одна группа не осталась с ней.
  const stillIn = report.results.some((r) => r.state === "protected" || r.state === "ban_failed");
  if (!stillIn) {
    await prisma.contact
      .update({ where: { id: contact.id }, data: { joinedGroupAt: null } })
      .catch((err) => logError("groupExit:resetContact", err));
    await prisma.purchase
      .updateMany({ where: { id: { in: purchases.map((p) => p.id) } }, data: { joinedAt: null } })
      .catch((err) => logError("groupExit:resetPurchase", err));
  }
  return report;
}

/** Журнал и отметка в «Ссылках»: человека удалили из группы. Сбой записи не откатывает удаление. */
async function recordRemoval(contactId: string, chatId: string, telegramUserId: string, actor: "owner" | "bot") {
  await prisma.accessEvent
    .create({
      data: { contactId, action: "removed", actor, detail: `удалён из группы Telegram ${telegramUserId}, чат ${chatId}` },
    })
    .catch((err) => logError("groupExit:accessEvent", err));
  // Раздел «Ссылки» ведёт links/: отметку «удалён» пишет он (динамический импорт — без круга).
  await import("./links/telegramInvites.js")
    .then((m) => m.markJoinsRemoved(chatId, telegramUserId))
    .catch((err) => logError("groupExit:inviteJoin", err));
  logInfo("groupExit", `контакт ${contactId}: удалён из чата ${chatId} (${actor})`);
}

/**
 * Сообщение хозяйке о проблеме. Свой ключ на каждый случай и вид (не общий
 * часовой «готово»), чтобы тревога не пряталась за прошлым сообщением.
 */
export async function alertOwnerProblem(key: string, text: string): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await techChatIds())[0];
  if (!botToken || !chatId) return;
  if (!(await shouldSendAlert(`group-exit:${key}`, { cooldownMs: 30 * 60_000 }))) return;
  await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("groupExit:alert", err));
}
