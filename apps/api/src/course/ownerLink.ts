import { randomBytes } from "node:crypto";
import { prisma, getSetting } from "../db.js";
import { chatIdFor, type Course } from "../courses.js";
import { createOneTimeInviteLink, getChatMemberStatus, revokeInviteLink } from "../telegram.js";
import { rememberInviteLink } from "../groupAccess.js";
import { issueCourseLink } from "./delivery.js";

/**
 * ВЫДАТЬ ЛИЧНУЮ ССЫЛКУ ОДНИМ НАЖАТИЕМ — общая логика для кнопки в Telegram-боте
 * владельца и кнопки на экране «Сегодня» в панели (08.11.2026).
 *
 * Два вида, и они НЕ мешают друг другу:
 *   web      — свежая ссылка на сайт с уроками. Выдача выпускает новую ссылку,
 *              прошлая гаснет (delivery.ts issueCourseLink — штатный путь).
 *   telegram — одноразовое приглашение в закрытую группу курса.
 *
 * Чего здесь НЕЛЬЗЯ (ошибки, найденные ревью в PR #64):
 *  - Приглашение тому, кто уже в группе, не выдаётся: его можно переслать
 *    подруге. Проверяем три вещи — отметка на покупке, отметка входа на
 *    контакте и сам Telegram (getChatMember). Не смогли проверить — отказ.
 *  - «В Telegram» не трогает сайтовую ссылку вообще, поэтому у кого Telegram
 *    нет или не нужен, сайтовый доступ не пропадает.
 *  - Никакого скрытого закрытия двери: ни отзыва доступа, ни выгона из группы.
 *    Гасится только прежнее НЕИСПОЛЬЗОВАННОЕ приглашение этого же человека.
 *
 * Дверь: вызывающий код обязан сам проверить, что просит владелец (чат из
 * trustedChatIds в боте, вход в панель по requireAuth).
 */

export type LinkKind = "web" | "telegram";

export type Person = { id: string; handle: string; name: string | null; courses: string[] };

export type FailReason =
  | "not-found"
  | "blocked"
  | "no-purchase"
  | "no-base"
  | "no-bot"
  | "no-group"
  | "in-group"
  | "check-failed"
  | "unknown-member"
  | "busy"
  | "tg-failed";

export type IssueResult =
  | { ok: true; kind: "web"; url: string; courses: string[] }
  | { ok: true; kind: "telegram"; links: { course: string; url: string }[] }
  | { ok: false; reason: FailReason };

/** Простыми словами — для бота и панели. */
export const REASON_TEXT: Record<FailReason, string> = {
  "not-found": "Человека не нашла.",
  blocked: "У этого человека доступ отобран или он помечен как спам. Сначала верните доступ в «Клиентах».",
  "no-purchase": "У этого человека нет оплаченного курса — выдавать ссылку не за что.",
  "no-base": "Адрес сайта не задан в настройках — ссылку собрать не из чего.",
  "no-bot": "Telegram-бот не подключён в настройках.",
  "no-group": "Группа этого курса не задана в настройках.",
  "in-group":
    "Этот человек уже в группе — новое приглашение не выдаю: его можно было бы переслать другому. Если нужен сайт, выдайте ссылку на сайт.",
  "check-failed":
    "Не получилось проверить, в группе ли человек. Попробуйте через минуту — наугад приглашение не выдаю.",
  "unknown-member":
    "Ей уже выдавали приглашение, а её Telegram мы не знаем — проверить, вошла ли она, нельзя. Спросите её или выдайте ссылку на сайт.",
  busy: "Для этого человека ссылка выдаётся прямо сейчас. Подождите минуту и посмотрите результат.",
  "tg-failed": "Telegram не дал приглашение. Проверьте, что бот — администратор группы с правом приглашать.",
};

// kicked — забанена вручную: приглашение ей всё равно можно переслать другому.
const IN_GROUP = new Set(["member", "administrator", "creator", "restricted", "kicked"]);

/** Один человек — одна выдача за раз (панель и бот одновременно не должны выпустить два приглашения). */
const issuing = new Set<string>();

export const MIN_QUERY = 2;
const FIND_LIMIT = 6;

const PERSON_SELECT = {
  id: true,
  username: true,
  igUserId: true,
  name: true,
  studentFirstName: true,
  studentLastName: true,
  purchases: { where: { revokedAt: null }, select: { course: true } },
} as const;

type PersonRow = {
  id: string;
  username: string | null;
  igUserId: string;
  name: string | null;
  studentFirstName: string | null;
  studentLastName: string | null;
  purchases: { course: string }[];
};

function toPerson(c: PersonRow): Person {
  return {
    id: c.id,
    handle: c.username ? `@${c.username}` : c.igUserId,
    name: [c.studentFirstName, c.studentLastName].filter(Boolean).join(" ") || c.name || null,
    courses: c.purchases.map((p) => p.course),
  };
}

/** Один человек по id — для подписи на карточке. */
export async function getPerson(id: string): Promise<Person | null> {
  const row = (await prisma.contact.findUnique({ where: { id }, select: PERSON_SELECT })) as PersonRow | null;
  return row ? toPerson(row) : null;
}

/** Люди, которым есть что выдавать: действующая покупка, доступ не отобран. */
export async function findPeople(query: string): Promise<Person[]> {
  const q = query.trim().replace(/^@/, "");
  if (q.length < MIN_QUERY) return [];
  const rows = await prisma.contact.findMany({
    where: {
      accessRevokedAt: null,
      spamBlockedAt: null,
      purchases: { some: { revokedAt: null } },
      OR: [
        { username: { contains: q } },
        { username: { contains: q.toLowerCase() } },
        { igUserId: q },
        { name: { contains: q } },
        { studentFirstName: { contains: q } },
        { studentLastName: { contains: q } },
      ],
    },
    select: PERSON_SELECT,
    take: FIND_LIMIT,
  });
  return (rows as PersonRow[]).map(toPerson);
}

/** Выдать ссылку. Каждый вызов — отдельное решение владельца (одно нажатие = одна выдача). */
export async function issueOwnerLink(contactId: string, kind: LinkKind): Promise<IssueResult> {
  if (issuing.has(contactId)) return { ok: false, reason: "busy" };
  issuing.add(contactId);
  try {
    return await issueOwnerLinkLocked(contactId, kind);
  } finally {
    issuing.delete(contactId);
  }
}

async function issueOwnerLinkLocked(contactId: string, kind: LinkKind): Promise<IssueResult> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return { ok: false, reason: "not-found" };
  if (contact.accessRevokedAt || contact.spamBlockedAt) return { ok: false, reason: "blocked" };

  const purchases = await prisma.purchase.findMany({
    where: { contactId, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (purchases.length === 0) return { ok: false, reason: "no-purchase" };

  if (kind === "web") {
    const url = await issueCourseLink(contactId, { automatic: false });
    if (!url) return { ok: false, reason: "no-base" };
    return { ok: true, kind: "web", url, courses: purchases.map((p) => p.course) };
  }

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return { ok: false, reason: "no-bot" };

  // Кого вообще можно звать: курс, в который человек ещё не вошёл. Если вход
  // на контакте уже отмечен, зовём только в курсы, купленные ПОСЛЕ него.
  // Известен Telegram человека — решает сам Telegram (вышла из группы — можно позвать снова).
  // Неизвестен — верим только отметкам входа, а прошлое приглашение без отметки не даёт
  // понять, вошла ли она: отказываем (его могли использовать по ссылке, созданной вручную).
  const candidates = contact.telegramUserId
    ? purchases
    : purchases.filter((p) => !p.joinedAt && (!contact.joinedGroupAt || p.createdAt > contact.joinedGroupAt));
  if (candidates.length === 0) return { ok: false, reason: "in-group" };
  if (!contact.telegramUserId && candidates.some((p) => p.inviteLink?.startsWith("https://t.me/"))) {
    return { ok: false, reason: "unknown-member" };
  }

  // Прицельная проверка у самого Telegram, пока ни одно приглашение не выпущено.
  const targets: { purchase: (typeof candidates)[number]; chatId: string }[] = [];
  let withoutGroup = 0;
  for (const p of candidates) {
    const chatId = await chatIdFor(p.course as Course);
    if (!chatId) {
      withoutGroup++;
      continue;
    }
    if (contact.telegramUserId) {
      const status = await getChatMemberStatus(botToken, chatId, contact.telegramUserId);
      if (status === null) return { ok: false, reason: "check-failed" };
      if (IN_GROUP.has(status)) continue;
    }
    targets.push({ purchase: p, chatId });
  }
  if (targets.length === 0) return { ok: false, reason: withoutGroup > 0 ? "no-group" : "in-group" };

  const links: { course: string; url: string }[] = [];
  const stale: { chatId: string; link: string }[] = [];
  for (const { purchase, chatId } of targets) {
    const url = await createOneTimeInviteLink(botToken, chatId);
    if (!url) {
      if (links.length === 0) return { ok: false, reason: "tg-failed" };
      continue; // часть приглашений уже выпущена — отдаём их, а не теряем
    }
    const old = purchase.inviteLink;
    if (old && old.startsWith("https://t.me/") && old !== url) stale.push({ chatId, link: old });
    await prisma.purchase.update({ where: { id: purchase.id }, data: { inviteLink: url } });
    links.push({ course: purchase.course, url });
  }
  // По этой ссылке handleChatMember узнает вошедшего, а вход не поднимет тревогу.
  await rememberInviteLink(contactId, links[links.length - 1].url);
  // Прежние неиспользованные приглашения гасим ПОСЛЕ того, как новые сохранены.
  for (const s of stale) await revokeInviteLink(botToken, s.chatId, s.link);
  return { ok: true, kind: "telegram", links };
}

// ---------- карточки владельца в боте: одноразовые и со сроком ----------

/** Живут 15 минут; после перезапуска сервера гаснут (это безопасная сторона). */
export const OFFER_TTL_MS = 15 * 60_000;
const MAX_OFFERS = 200;
const offers = new Map<string, { contactId: string; until: number }>();

/** Метка для кнопки. Короткая: у Telegram на callback_data всего 64 байта. */
export function createOffer(contactId: string): string {
  const now = Date.now();
  for (const [k, v] of offers) if (v.until < now) offers.delete(k);
  while (offers.size >= MAX_OFFERS) offers.delete(offers.keys().next().value as string);
  const nonce = randomBytes(6).toString("hex");
  offers.set(nonce, { contactId, until: now + OFFER_TTL_MS });
  return nonce;
}

/** Погасить и вернуть человека. Второй раз и после срока — null. Без await внутри:
 *  два одновременных нажатия не пройдут оба. */
export function takeOffer(nonce: string): string | null {
  const offer = offers.get(nonce);
  offers.delete(nonce);
  if (!offer || offer.until < Date.now()) return null;
  return offer.contactId;
}
