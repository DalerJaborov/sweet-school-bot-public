import { prisma, getSetting, logError, logInfo, logWarn } from "../db.js";
import { chatKeyFor, COURSE_50, COURSE_70, COURSE_TITLE } from "../courses.js";
import { alertOwnerProblem, removeFromGroupChat } from "../groupExit.js";

/**
 * ПРИГЛАШЕНИЯ В TELEGRAM-ГРУППЫ ИЗ ПАНЕЛИ (раздел «Ссылки», 08.11.2026).
 *
 * Бот сам выдаёт ссылку на одного человека после проверенного чека (telegram.ts
 * createOneTimeInviteLink) — это отдельный путь. Здесь — ручная выдача:
 * хозяйка или сестра выбирают группу и сколько людей, получают ссылку и
 * пересылают её сами (WhatsApp, личка). Каждая такая ссылка записана в базу:
 *  • её можно отозвать кнопкой;
 *  • вход по ней не поднимает тревогу «непонятный вход» (groupAccess.ts);
 *  • если ссылка выдана конкретной ученице на один вход — её Telegram
 *    связывается с карточкой, и «Отобрать доступ» сможет её удалить.
 *
 * Какая группа к какому курсу — из настроек, тем же ключом, что и автовыдача
 * (courses.ts chatKeyFor): telegramChatId50 — «Арт-десерты», telegramChatId70 —
 * «21 рецепт». telegramQaGroupId — учебная группа вопросов (qaGroup.ts).
 *
 * Токен бота не попадает ни в ответ панели, ни в журнал: ошибки Telegram
 * пересказываются простыми словами, а сырой текст перед записью чистится.
 */

export const GROUP_KEYS = ["COURSE50", "COURSE70", "QA"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

const GROUP_SETTING: Record<GroupKey, string> = {
  COURSE50: chatKeyFor(COURSE_50),
  COURSE70: chatKeyFor(COURSE_70),
  QA: "telegramQaGroupId",
};

export const GROUP_LABEL: Record<GroupKey, string> = {
  COURSE50: `Курс «${COURSE_TITLE[COURSE_50]}»`,
  COURSE70: `Курс «${COURSE_TITLE[COURSE_70]}»`,
  QA: "Группа вопросов учениц",
};

export const INVITE_PRESETS = {
  one: { memberLimit: 1, days: 30, label: "1 человек · 30 дней" },
  five: { memberLimit: 5, days: 7, label: "До 5 человек · 7 дней" },
  twenty: { memberLimit: 20, days: 3, label: "До 20 человек · 3 дня" },
} as const;
export type InvitePreset = keyof typeof INVITE_PRESETS;

export type InviteFailure =
  | "no_bot"
  | "no_group"
  | "no_rights"
  | "not_member"
  | "group_moved"
  | "bad_token"
  | "unavailable"
  | "not_found"
  | "save_failed"
  | "protected"
  | "unknown";

const RIGHTS_HINT =
  "Сделайте бота администратором группы с правом «Приглашать участников» (в Telegram оно может называться «Пригласительные ссылки») и нажмите ещё раз.";

export const FAILURE_TEXT: Record<InviteFailure, string> = {
  no_bot: "Бот Telegram не подключён. Откройте «Настройки» и вставьте токен бота.",
  no_group: "Для этой группы не указан ID. Откройте «Настройки» и впишите ID группы.",
  no_rights: `У бота нет права приглашать людей в эту группу. ${RIGHTS_HINT}`,
  not_member: `Бота нет в этой группе. Добавьте его в группу. ${RIGHTS_HINT}`,
  group_moved:
    "Telegram сменил ID этой группы (так бывает, когда группа становится большой). Откройте «Настройки» и впишите новый ID.",
  bad_token: "Telegram не принимает токен бота. Проверьте токен в «Настройках».",
  unavailable: "Telegram сейчас не отвечает. Попробуйте через минуту.",
  not_found: "Такой ссылки нет — обновите страницу.",
  save_failed: "Ссылку не удалось сохранить, поэтому она сразу отменена. Попробуйте ещё раз.",
  protected: "Это администратор группы: бот администраторов не удаляет. Уберите человека вручную в самой группе.",
  unknown: "Telegram не дал сделать ссылку. Попробуйте ещё раз через минуту; если повторится — напишите разработчику.",
};

export class InviteError extends Error {
  constructor(public readonly reason: InviteFailure) {
    super(FAILURE_TEXT[reason]);
  }
}

/** Убирает токен бота из любого текста ошибки: адрес Bot API несёт его прямо в пути. */
export function redactBotToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "***");
}

type BotFailure = { ok: false; code?: number; description: string; network?: boolean };
type BotResult<T> = { ok: true; result: T } | BotFailure;

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

async function botCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<BotResult<T>> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (data.ok) return { ok: true, result: data.result as T };
    return {
      ok: false,
      code: data.error_code ?? res.status,
      description: redactBotToken(data.description ?? `HTTP ${res.status}`),
    };
  } catch (err) {
    return { ok: false, network: true, description: redactBotToken(String(err)) };
  }
}

/** Ответ Telegram → понятная причина. Экспортирована для теста. */
export function classifyFailure(f: { code?: number; description: string; network?: boolean }): InviteFailure {
  const d = f.description;
  if (f.network) return "unavailable";
  if (f.code === 401 || f.code === 404 || /unauthorized|^not found$/i.test(d)) return "bad_token";
  if (/upgraded to a supergroup|migrate_to_chat_id/i.test(d)) return "group_moved";
  if (
    /not enough rights|chat_admin_required|need administrator|have no rights|administrator rights|can_invite_users|not an administrator/i.test(
      d,
    )
  )
    return "no_rights";
  if (/bot is not a member|bot was kicked|chat not found|not a member|peer_id_invalid|channel_private/i.test(d))
    return "not_member";
  if (f.code === 429 || (f.code ?? 0) >= 500) return "unavailable";
  return "unknown";
}

/**
 * Настройка группы (нет прав, бота нет, токен не тот) — хозяйка видит понятный
 * текст прямо на экране, тревога в Telegram не нужна: в журнал как предупреждение.
 * Непонятный отказ или сбой сети — ошибка, она попадает в журнал ошибок.
 */
function reportFailure(scope: string, reason: InviteFailure, text: string): void {
  const configIssue: InviteFailure[] = ["no_rights", "not_member", "group_moved", "bad_token"];
  if (configIssue.includes(reason)) logWarn(scope, redactBotToken(text));
  else logError(scope, new Error(redactBotToken(text)));
}

function settingFor(group: GroupKey): string {
  return GROUP_SETTING[group];
}

/** Какие группы настроены — для экрана: ненастроенную лучше не предлагать. */
export async function groupOptions(): Promise<{ key: GroupKey; label: string; ready: boolean }[]> {
  return Promise.all(
    GROUP_KEYS.map(async (key) => ({
      key,
      label: GROUP_LABEL[key],
      ready: Boolean((await getSetting(settingFor(key)))?.trim()),
    })),
  );
}

export async function botConfigured(): Promise<boolean> {
  return Boolean((await getSetting("telegramBotToken"))?.trim());
}

export type CreateInviteInput = {
  group: GroupKey;
  preset: InvitePreset;
  name?: string | null;
  contactId?: string | null;
};

export async function createPanelInvite(input: CreateInviteInput) {
  const token = (await getSetting("telegramBotToken"))?.trim();
  if (!token) throw new InviteError("no_bot");
  const chatId = (await getSetting(settingFor(input.group)))?.trim();
  if (!chatId) throw new InviteError("no_group");

  const preset = INVITE_PRESETS[input.preset];
  const expiresAt = new Date(Date.now() + preset.days * 86_400_000);
  // Имя видно и в самом Telegram в списке ссылок группы — по нему понятно,
  // кому выдана ссылка. Ограничение Telegram — 32 знака.
  const name = (input.name ?? "").trim().slice(0, 32) || null;
  const r = await botCall<{ invite_link?: string }>(token, "createChatInviteLink", {
    chat_id: chatId,
    member_limit: preset.memberLimit,
    expire_date: Math.floor(expiresAt.getTime() / 1000),
    ...(name ? { name } : {}),
  });
  if (!r.ok || !r.result?.invite_link) {
    const failure: BotFailure = r.ok ? { ok: false, description: "пустой ответ" } : r;
    const reason = classifyFailure(failure);
    reportFailure("links:telegramCreate", reason, `${input.group}: ${failure.description}`);
    throw new InviteError(reason);
  }
  const inviteLink = r.result.invite_link;
  const row = await prisma.telegramInvite
    .create({
      data: {
        groupKey: input.group,
        chatId,
        inviteLink,
        name,
        memberLimit: preset.memberLimit,
        expiresAt,
        contactId: input.contactId ?? null,
      },
    })
    .catch(async (err) => {
      // Ссылка в Telegram уже есть, а у нас о ней записи нет: её нельзя было бы
      // ни отозвать из панели, ни узнать вошедшего. Гасим её сразу.
      logError("links:telegramSave", err);
      await botCall(token, "revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink });
      throw new InviteError("save_failed");
    });
  logInfo(
    "links:telegram",
    `выдано приглашение ${row.id}: ${input.group}, входов ${preset.memberLimit}, ${preset.days} дн.`,
  );
  return row;
}

/** Отозвать: ссылка перестаёт пускать сразу. Уже вошедших не выгоняет. */
export async function revokePanelInvite(id: string) {
  const invite = await prisma.telegramInvite.findUnique({ where: { id } });
  if (!invite) throw new InviteError("not_found");
  if (invite.revokedAt) return invite;
  const token = (await getSetting("telegramBotToken"))?.trim();
  if (!token) throw new InviteError("no_bot");
  const r = await botCall(token, "revokeChatInviteLink", { chat_id: invite.chatId, invite_link: invite.inviteLink });
  // Ссылка уже истекла или удалена в самом Telegram — цель достигнута, отмечаем.
  if (
    !r.ok &&
    !/invite_hash_expired|invite_hash_invalid|invite link.*(expired|not found|revoked)/i.test(r.description)
  ) {
    const reason = classifyFailure(r);
    reportFailure("links:telegramRevoke", reason, `${invite.groupKey}: ${r.description}`);
    throw new InviteError(reason);
  }
  await prisma.telegramInvite.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  logInfo("links:telegram", `отозвано приглашение ${id}`);
  return { ...invite, revokedAt: new Date() };
}

/**
 * «Отобрать доступ» (groupAccess.ts): гасим и ручные ссылки этой ученицы.
 * Возвращает, сколько отозвать НЕ удалось — молча сказать «готово» нельзя.
 */
export async function revokeInvitesForContact(contactId: string): Promise<number> {
  const active = await prisma.telegramInvite.findMany({ where: { contactId, revokedAt: null }, select: { id: true } });
  let failed = 0;
  for (const { id } of active) {
    await revokePanelInvite(id).catch((err) => {
      failed += 1;
      logError("links:revokeForContact", err);
    });
  }
  return failed;
}

/**
 * Выгнать из группы того, кто вошёл по ссылке из панели. Бан с немедленной
 * разблокировкой, как в groupAccess.revokeAccess: человека удаляет, но не
 * оставляет в чёрном списке навсегда.
 */
export async function removeInviteJoiner(inviteId: string, joinId: string): Promise<void> {
  const join = await prisma.telegramInviteJoin.findUnique({ where: { id: joinId } });
  const invite =
    join && join.inviteId === inviteId ? await prisma.telegramInvite.findUnique({ where: { id: inviteId } }) : null;
  if (!join || !invite) throw new InviteError("not_found");
  if (join.removedAt) return;
  const token = (await getSetting("telegramBotToken"))?.trim();
  if (!token) throw new InviteError("no_bot");
  // Бан и разбан — единственной дверью groupExit.ts (проверка админа, повтор, тревога).
  const exit = await removeFromGroupChat(token, invite.chatId, join.telegramUserId);
  if (exit.state === "protected") throw new InviteError("protected");
  if (exit.state === "ban_failed") {
    const reason = classifyFailure({ description: exit.detail ?? "" });
    reportFailure("links:telegramKick", reason, `${invite.groupKey}: ${exit.detail ?? ""}`);
    throw new InviteError(reason);
  }
  if (exit.state === "unban_failed") {
    await alertOwnerProblem(
      `join:${joinId}`,
      `Из группы удалён человек (Telegram ${join.telegramUserId}), но снять бан не вышло: вернуться он не сможет. Разбаньте его в группе вручную.`,
    );
  }
  await prisma.telegramInviteJoin.updateMany({
    where: { id: joinId, removedAt: null },
    data: { removedAt: new Date() },
  });
  logInfo("links:telegram", `удалён из группы вошедший по приглашению ${inviteId}`);
}

/** Человека удалили из группы чем-то кроме кнопки в «Ссылках» (переход на сайт, отзыв): отмечаем его входы по ссылкам этого чата. */
export async function markJoinsRemoved(chatId: string, telegramUserId: string): Promise<void> {
  const invites = await prisma.telegramInvite.findMany({ where: { chatId }, select: { id: true } });
  const ids = (invites ?? []).map((i) => i.id);
  if (ids.length === 0) return;
  await prisma.telegramInviteJoin.updateMany({
    where: { telegramUserId, removedAt: null, inviteId: { in: ids } },
    data: { removedAt: new Date() },
  });
}

export type InviteStatus = "active" | "used" | "expired" | "revoked";

/**
 * «Действует» — пока ссылка не отозвана и не истекла, даже если входов уже
 * столько, сколько задумано: Telegram считает людей В ГРУППЕ, а не входы, и
 * ссылка, которую бот не смог погасить сам, всё ещё пускает. Кнопка «Отозвать»
 * в таком случае обязана быть на экране.
 */
export function inviteStatus(
  invite: { revokedAt: Date | null; expiresAt: Date | null; memberLimit: number | null; joinedCount: number },
  now = new Date(),
): InviteStatus {
  const full = invite.memberLimit != null && invite.joinedCount >= invite.memberLimit;
  if (invite.revokedAt) return full ? "used" : "revoked";
  if (invite.expiresAt && invite.expiresAt <= now) return "expired";
  return "active";
}

export async function listPanelInvites(take = 200) {
  const rows = await prisma.telegramInvite.findMany({ orderBy: { createdAt: "desc" }, take });
  const joins = rows.length
    ? await prisma.telegramInviteJoin.findMany({
        where: { inviteId: { in: rows.map((r) => r.id) } },
        orderBy: { joinedAt: "asc" },
      })
    : [];
  const joinsOf = new Map<string, typeof joins>();
  for (const j of joins) joinsOf.set(j.inviteId, [...(joinsOf.get(j.inviteId) ?? []), j]);
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, name: true, username: true, studentFirstName: true, studentLastName: true },
      })
    : [];
  const who = new Map(
    contacts.map((c) => [
      c.id,
      [c.studentFirstName, c.studentLastName].filter(Boolean).join(" ") ||
        c.name ||
        (c.username ? `@${c.username}` : null),
    ]),
  );
  return rows.map((r) => ({
    id: r.id,
    group: r.groupKey,
    groupLabel: (GROUP_KEYS as readonly string[]).includes(r.groupKey)
      ? GROUP_LABEL[r.groupKey as GroupKey]
      : r.groupKey,
    link: r.inviteLink,
    name: r.name ?? (r.contactId ? (who.get(r.contactId) ?? null) : null),
    contactId: r.contactId,
    memberLimit: r.memberLimit,
    joinedCount: r.joinedCount,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    status: inviteStatus(r),
    joins: (joinsOf.get(r.id) ?? []).map((j) => ({
      id: j.id,
      name: [j.name, j.username ? `@${j.username}` : null].filter(Boolean).join(" ") || `Telegram ${j.telegramUserId}`,
      joinedAt: j.joinedAt,
      removed: Boolean(j.removedAt),
    })),
  }));
}

export type JoinedUser = { id?: number; first_name?: string; last_name?: string; username?: string };

/**
 * Вход в группу по ссылке из панели (событие chat_member, groupAccess.ts).
 * true — ссылка наша, тревога «непонятный вход» не нужна.
 */
export async function recordPanelInviteJoin(link: string, user: JoinedUser, joined: boolean): Promise<boolean> {
  const invite = await prisma.telegramInvite.findUnique({ where: { inviteLink: link } }).catch((err) => {
    logError("links:join", err);
    return null;
  });
  if (!invite) return false;
  if (!joined || user.id == null) return true;
  const telegramUserId = user.id;
  const now = new Date();
  const counted = await prisma.telegramInvite
    .update({ where: { id: invite.id }, data: { joinedCount: { increment: 1 }, lastJoinedAt: now } })
    .catch((err) => {
      logError("links:joinCount", err);
      return null;
    });
  // КТО вошёл — чтобы по общей ссылке (на 5 или 20 человек) хозяйка видела
  // людей и могла выгнать лишнего. Только то, что Telegram сам прислал.
  await prisma.telegramInviteJoin
    .create({
      data: {
        inviteId: invite.id,
        telegramUserId: String(telegramUserId),
        name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 80) || null,
        username: user.username?.slice(0, 64) ?? null,
      },
    })
    .catch((err) => logError("links:joinWho", err));
  // Набрали задуманное число входов — гасим ссылку сами. member_limit в
  // Telegram — это сколько человек В ГРУППЕ одновременно: вышедший освобождает
  // место, и без отзыва ссылку можно было бы переслать дальше.
  const joinedCount = counted?.joinedCount ?? invite.joinedCount + 1;
  if (invite.memberLimit != null && joinedCount >= invite.memberLimit && !invite.revokedAt) {
    await revokePanelInvite(invite.id).catch((err) => logError("links:autoRevoke", err));
  }
  // Связываем Telegram с карточкой только для ссылки на ОДИН вход: по ссылке на
  // пятерых первым мог войти кто угодно из пяти.
  if (invite.contactId && invite.memberLimit === 1) {
    await prisma.contact
      .updateMany({
        where: { id: invite.contactId, telegramUserId: null },
        data: { telegramUserId: String(telegramUserId) },
      })
      .catch((err) => logError("links:joinContact", err));
    await prisma.contact
      .updateMany({ where: { id: invite.contactId, joinedGroupAt: null }, data: { joinedGroupAt: now } })
      .catch((err) => logError("links:joinContact", err));
    if (invite.groupKey === COURSE_50 || invite.groupKey === COURSE_70) {
      await prisma.purchase
        .updateMany({
          where: { contactId: invite.contactId, course: invite.groupKey, joinedAt: null, revokedAt: null },
          data: { joinedAt: now },
        })
        .catch((err) => logError("links:joinPurchase", err));
    }
  }
  return true;
}
