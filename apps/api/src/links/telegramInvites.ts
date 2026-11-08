import { prisma, getSetting, logError, logInfo, logWarn } from "../db.js";
import { chatKeyFor, COURSE_50, COURSE_70, COURSE_TITLE } from "../courses.js";

/**
 * ПРИГЛАШЕНИЯ В TELEGRAM-ГРУППЫ ИЗ ПАНЕЛИ (раздел «Ссылки», 08.11.2026).
 *
 * Бот сам выдаёт одноразовую ссылку после проверенного чека (telegram.ts
 * createOneTimeInviteLink) — этот путь не трогаем. Здесь — ручная выдача:
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
  const row = await prisma.telegramInvite.create({
    data: {
      groupKey: input.group,
      chatId,
      inviteLink: r.result.invite_link,
      name,
      memberLimit: preset.memberLimit,
      expiresAt,
      contactId: input.contactId ?? null,
    },
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

/** «Отобрать доступ» (groupAccess.ts): гасим и ручные ссылки этой ученицы. */
export async function revokeInvitesForContact(contactId: string): Promise<void> {
  const active = await prisma.telegramInvite.findMany({ where: { contactId, revokedAt: null }, select: { id: true } });
  for (const { id } of active) {
    await revokePanelInvite(id).catch((err) => logError("links:revokeForContact", err));
  }
}

export type InviteStatus = "active" | "used" | "expired" | "revoked";

export function inviteStatus(
  invite: { revokedAt: Date | null; expiresAt: Date | null; memberLimit: number | null; joinedCount: number },
  now = new Date(),
): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.memberLimit != null && invite.joinedCount >= invite.memberLimit) return "used";
  if (invite.expiresAt && invite.expiresAt <= now) return "expired";
  return "active";
}

export async function listPanelInvites(take = 200) {
  const rows = await prisma.telegramInvite.findMany({ orderBy: { createdAt: "desc" }, take });
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
  }));
}

/**
 * Вход в группу по ссылке из панели (событие chat_member, groupAccess.ts).
 * true — ссылка наша, тревога «непонятный вход» не нужна.
 */
export async function recordPanelInviteJoin(link: string, telegramUserId: number, joined: boolean): Promise<boolean> {
  const invite = await prisma.telegramInvite.findUnique({ where: { inviteLink: link } }).catch((err) => {
    logError("links:join", err);
    return null;
  });
  if (!invite) return false;
  if (!joined) return true;
  const now = new Date();
  await prisma.telegramInvite
    .update({ where: { id: invite.id }, data: { joinedCount: { increment: 1 }, lastJoinedAt: now } })
    .catch((err) => logError("links:joinCount", err));
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
