import { prisma, getSetting, logError } from "./db.js";
import { isListedPersonal, readPersonalList, LIST_REASON } from "./ai/personalList.js";
import { singleFlight } from "./services/singleFlight.js";
import { env } from "./env.js";

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

/**
 * Первое сообщение родни приходит раньше, чем фоновый тик узнаёт ник контакта, и бот успел бы
 * ответить. Для Instagram без ника, при непустом списке, профиль запрашивается сразу (с таймаутом);
 * совпало со списком — контакт помечается личным. Возвращает true, если пометили.
 */
const profileTried = new Map<string, number>();
const PROFILE_RETRY_MS = 30 * 60_000;

export async function markListedPersonalNow(contact: {
  id: string;
  igUserId: string;
  channel: string;
  username: string | null;
  personal: boolean;
  profileAt?: Date | null;
}): Promise<boolean> {
  if (contact.personal || contact.username || contact.channel !== "INSTAGRAM") return false;
  // Профиль уже запрашивали (тик или прошлое сообщение) — на каждое сообщение в Graph не ходим.
  if (contact.profileAt) return false;
  const lastTry = profileTried.get(contact.id);
  if (lastTry && Date.now() - lastTry < PROFILE_RETRY_MS) return false;
  try {
    if ((await readPersonalList()).length === 0) return false;
    profileTried.set(contact.id, Date.now());
    if (profileTried.size > 5000) profileTried.clear();
    const profile = await fetchProfile(contact.igUserId, contact.channel);
    if (!profile?.username || !(await isListedPersonal(profile.username))) return false;
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        personal: true,
        personalReason: LIST_REASON,
        username: profile.username,
        name: profile.name ?? undefined,
      },
    });
    return true;
  } catch (err) {
    logError("profiles:markListedNow", err);
    return false;
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
      where: {
        channel: { in: ["INSTAGRAM", "MESSENGER"] },
        OR: [{ profileAt: null }, { profileAt: { lt: new Date(Date.now() - MAX_AGE_MS) } }],
      },
      orderBy: { updatedAt: "desc" },
      take: BATCH,
    });

    for (const contact of stale) {
      const profile = await fetchProfile(contact.igUserId, contact.channel);
      const listed = !contact.personal && (await isListedPersonal(profile?.username ?? contact.username));
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          // Отметку ставим всегда, даже когда профиль не отдали: иначе такие
          // контакты будут перезапрашиваться каждый тик, вечно.
          profileAt: new Date(),
          ...(listed ? { personal: true, personalReason: "Список личных контактов (добавлен владельцем)" } : {}),
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

/**
 * Проверка при входящем сообщении. true — контакт помечен личным, отвечать не
 * нужно. Вызывать после проверок «личный/спам», до ответа бота.
 */
export async function silenceIfFollowedByBusiness(
  contact: { id: string; channel: string; igUserId: string; paid: boolean; personal: boolean },
  opts: { hasImage: boolean }
): Promise<boolean> {
  if (contact.channel !== "INSTAGRAM" || contact.personal || contact.paid || opts.hasImage) return false;
  const follows = await businessFollowsUser(contact.igUserId);
  if (follows !== true) return false;
  const purchases = await prisma.purchase.count({ where: { contactId: contact.id } }).catch(() => 1);
  if (purchases > 0) return false;
  await prisma.contact
    .update({
      where: { id: contact.id },
      data: { personal: true, personalReason: "Ширин подписана на этот аккаунт (Instagram), бот не отвечает" },
    })
    .catch((err) => logError("profiles:markFollowed", err));
  return true;
}
