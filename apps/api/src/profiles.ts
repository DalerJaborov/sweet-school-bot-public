import { prisma, getSetting, logError } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { env } from "./env.js";
import { showsCourseInterest } from "./ai/relevance.js";

/**
 * ИМЯ И АВАТАР КЛИЕНТА.
 *
 * В панели человек должен выглядеть человеком: лицо, имя, ник — а не строка
 * «1838771154305671». Graph отдаёт профиль по тому же идентификатору, которым
 * приходит сообщение, поэтому нужен один запрос на контакт.
 *
 * СОГЛАСИЕ. Часть людей профиль не отдаёт: Graph отвечает «User consent is
 * required» (код 230) — обычно это те, кто пришёл из рекламы и в приложении
 * доступ к профилю не подтверждал. Это НЕ ошибка и не повод повторять запрос
 * каждую минуту: помечаем время попытки и больше сегодня не трогаем, а в панели
 * рисуем кружок с буквой.
 *
 * ССЫЛКА НА АВАТАР ПРОТУХАЕТ — CDN Instagram выдаёт её со сроком. Поэтому
 * профиль обновляется раз в сутки, а не запрашивается на каждый показ списка.
 */

const GRAPH_VERSION = "v23.0";
const IG_ORIGIN = "https://graph.instagram.com";
const FB_ORIGIN = "https://graph.facebook.com";
const MAX_AGE_MS = 24 * 3_600_000;
const TIMEOUT_MS = 12_000;
/** За один проход — небольшая пачка: профили нужны для удобства, а не срочно. */
const BATCH = 8;

type Profile = { name?: string; username?: string; profile_pic?: string; profile_picture_url?: string };

async function fetchProfile(igUserId: string, channel: string): Promise<Profile | null> {
  if (channel !== "INSTAGRAM" && channel !== "MESSENGER") return null;
  const messenger = channel === "MESSENGER";
  const token = (await getSetting(messenger ? "fbPageToken" : "igToken"))?.trim();
  if (!token) return null;

  const fields = messenger ? "name,profile_pic" : "name,username,profile_pic";
  const path = `/${GRAPH_VERSION}/${igUserId}?fields=${fields}`;

  const url = messenger
    ? `${FB_ORIGIN}${path}&access_token=${encodeURIComponent(token)}`
    : env.igProxyBase
      ? `${env.igProxyBase}${path}&access_token=${encodeURIComponent(token)}`
      : `${IG_ORIGIN}${path}`;
  const headers: Record<string, string> = messenger
    ? {}
    : env.igProxyBase
      ? env.igProxyKey
        ? { "x-proxy-key": env.igProxyKey }
        : {}
      : { Authorization: `Bearer ${token}` };

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = (await res.json()) as Profile & { error?: { code?: number } };
    // 230 — «нужно согласие пользователя». Ожидаемый исход, не пишем в журнал:
    // иначе он зарастёт одинаковыми строками про половину клиентов.
    if (!res.ok || data.error) return null;
    return data;
  } catch (err) {
    logError("profiles:fetch", err);
    return null;
  }
}

/** Догружает профили тем, у кого их ещё нет или они устарели. Дёргается общим тиком. */
export async function refreshProfiles(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("profiles", refreshProfilesOnce);
}

async function refreshProfilesOnce(): Promise<void> {
  try {
    const stale = await prisma.contact.findMany({
      where: { channel: { in: ["INSTAGRAM", "MESSENGER"] }, OR: [{ profileAt: null }, { profileAt: { lt: new Date(Date.now() - MAX_AGE_MS) } }] },
      orderBy: { updatedAt: "desc" },
      take: BATCH,
    });

    for (const contact of stale) {
      const profile = await fetchProfile(contact.igUserId, contact.channel);
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          // Отметку ставим всегда, даже когда профиль не отдали: иначе такие
          // контакты будут перезапрашиваться каждый тик, вечно.
          profileAt: new Date(),
          name: profile?.name ?? contact.name,
          username: profile?.username ?? contact.username,
          avatarUrl: profile?.profile_pic ?? profile?.profile_picture_url ?? contact.avatarUrl,
        },
      });
    }
  } catch (err) {
    logError("profiles", err);
  }
}

/**
 * НА КОГО ПОДПИСАНА ШИРИН — БОТ ИМ НЕ ОТВЕЧАЕТ (владелец 08.11.2026).
 *
 * Если хозяйка подписана на аккаунт, это почти всегда знакомый ей человек:
 * родня, подруга, коллега, поставщик. Бот не должен вмешиваться в их разговор.
 *
 * Источник данных — User Profile API Instagram: поле `is_business_follow_user`
 * (ФАКТ: описано в документации Meta, «User Profile API», Messaging API). Это
 * поле отдаёт текущее состояние подписки на момент запроса.
 *
 * ЧЕГО НЕ ДЕЛАЕМ. Не молчим, если:
 *  - человек уже платил или у него есть покупка: доступ к курсу, ссылка и
 *    поддержка важнее, чем «Ширин на него подписана» (она могла подписаться на
 *    ученицу сама);
 *  - в сообщении есть картинка: это может быть чек, а потерянный чек хуже
 *    лишнего ответа знакомой;
 *  - API не ответил или не дал согласия: сомнение — отвечаем как обычно.
 * Отметка ставится как «личный контакт» (Contact.personal) с понятной причиной:
 * владелец видит её в панели и снимает одним нажатием.
 */
const FOLLOW_CACHE_MS = 6 * 3_600_000;
const followCache = new Map<string, { at: number; follows: boolean }>();

/** true — Ширин подписана на этот аккаунт; null — не удалось узнать. */
export async function businessFollowsUser(igUserId: string): Promise<boolean | null> {
  const cached = followCache.get(igUserId);
  if (cached && Date.now() - cached.at < FOLLOW_CACHE_MS) return cached.follows;
  const token = (await getSetting("igToken"))?.trim();
  if (!token) return null;
  const path = `/${GRAPH_VERSION}/${igUserId}?fields=is_business_follow_user`;
  const url = env.igProxyBase ? `${env.igProxyBase}${path}&access_token=${encodeURIComponent(token)}` : `${IG_ORIGIN}${path}`;
  const headers: Record<string, string> = env.igProxyBase
    ? env.igProxyKey
      ? { "x-proxy-key": env.igProxyKey }
      : {}
    : { Authorization: `Bearer ${token}` };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = (await res.json()) as { is_business_follow_user?: boolean; error?: unknown };
    if (!res.ok || data.error || typeof data.is_business_follow_user !== "boolean") return null;
    followCache.set(igUserId, { at: Date.now(), follows: data.is_business_follow_user });
    return data.is_business_follow_user;
  } catch (err) {
    logError("profiles:followCheck", err);
    return null;
  }
}

/** Только для тестов. */
export function resetFollowCache(): void {
  followCache.clear();
}

/** Причина отметки «личный», которую ставит САМ бот по подписке Ширин. По ней
 *  отличаем авто-отметку от ручной: ручную («Отмечен вручную», «Запрет
 *  автоответов владельцем») бот не снимает никогда. */
export const FOLLOW_PERSONAL_REASON = "Ширин подписана на этот аккаунт (Instagram), бот не отвечает";

export function isAutoFollowPersonal(contact: { personal: boolean; personalReason?: string | null }): boolean {
  return contact.personal && contact.personalReason === FOLLOW_PERSONAL_REASON;
}

type FollowContact = {
  id: string;
  channel: string;
  igUserId: string;
  paid: boolean;
  personal: boolean;
  personalReason?: string | null;
  adReferralAt?: Date | null;
};
/** Что человек прислал сейчас: текст (или расшифровка голоса) и кнопка воронки. */
export type ClientSignal = { text?: string | null; payload?: string | null };

/** Сколько прошлых входящих смотрим в поисках вопроса про курс. */
const INTEREST_HISTORY = 30;

/**
 * ЗНАКОМЫЙ ИЛИ КЛИЕНТ? (владелец 09.11.2026: «чтобы никто не оставался без
 * ответа»). Подписка Ширин — слабый признак: она подписывается и на учениц, и на
 * тех, кто пришёл с рекламы, и на тестовый аккаунт владельца. Отметка «личный»
 * по подписке молчала навсегда даже на «сколько стоит курс?».
 *
 * Поэтому подписка глушит бота, только если НЕТ ни одного признака клиента:
 *  - сам нажал кнопку воронки (payload `step:...`);
 *  - сейчас или раньше написал про курс, цену, оплату, запись
 *    (ai/relevance.ts::showsCourseInterest — те же правила, что у фильтра «по делу»);
 *  - пришёл из рекламы (adReferralAt) или через воронку (есть доставка шагов);
 *  - уже покупал.
 * Раньше написанный вопрос про курс ищется в истории — так решение устойчиво
 * без новой отметки в базе: следующий «а когда начало?» тоже получит ответ.
 */
async function looksLikeClient(contact: FollowContact, signal: ClientSignal): Promise<boolean> {
  if (contact.paid || contact.adReferralAt) return true;
  if (signal.payload?.startsWith("step:")) return true;
  if (showsCourseInterest(signal.text)) return true;
  const [purchases, deliveries, history] = await Promise.all([
    prisma.purchase.count({ where: { contactId: contact.id } }).catch(() => 1),
    prisma.delivery.count({ where: { contactId: contact.id } }).catch(() => 0),
    prisma.message
      .findMany({
        where: { contactId: contact.id, direction: "IN", text: { not: null } },
        orderBy: { createdAt: "desc" },
        take: INTEREST_HISTORY,
        select: { text: true },
      })
      .catch(() => []),
  ]);
  if ((purchases ?? 0) > 0 || (deliveries ?? 0) > 0) return true;
  return (history ?? []).some((m) => showsCourseInterest(m.text));
}

/**
 * Снять АВТО-отметку «Ширин подписана», если человек ведёт себя как клиент.
 * Возвращает контакт с актуальной отметкой. Ручную отметку не трогает.
 * Вызывать ДО проверки «личный» (webhook.ts, funnel.ts — комментарии).
 */
export async function releaseFollowSilenceIfClient<C extends FollowContact>(contact: C, signal: ClientSignal): Promise<C> {
  if (!isAutoFollowPersonal(contact)) return contact;
  if (!(await looksLikeClient(contact, signal))) return contact;
  try {
    await prisma.contact.update({ where: { id: contact.id }, data: { personal: false, personalReason: null } });
  } catch (err) {
    logError("profiles:releaseFollowed", err);
    return contact;
  }
  return { ...contact, personal: false, personalReason: null };
}

/**
 * Проверка при входящем сообщении. true — контакт помечен личным, отвечать не
 * нужно. Вызывать после проверок «личный/спам», до ответа бота.
 */
export async function silenceIfFollowedByBusiness(
  contact: FollowContact,
  opts: { hasImage: boolean } & ClientSignal
): Promise<boolean> {
  if (contact.channel !== "INSTAGRAM" || contact.personal || contact.paid || opts.hasImage) return false;
  // Явный признак клиента в САМОМ сообщении — даже не спрашиваем Meta о подписке.
  if (opts.payload?.startsWith("step:") || showsCourseInterest(opts.text)) return false;
  const follows = await businessFollowsUser(contact.igUserId);
  if (follows !== true) return false;
  if (await looksLikeClient(contact, opts)) return false;
  await prisma.contact
    .update({
      where: { id: contact.id },
      data: { personal: true, personalReason: FOLLOW_PERSONAL_REASON },
    })
    .catch((err) => logError("profiles:markFollowed", err));
  return true;
}
