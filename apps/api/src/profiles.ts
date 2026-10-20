import { prisma, getSetting, logError } from "./db.js";
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
      where: { OR: [{ profileAt: null }, { profileAt: { lt: new Date(Date.now() - MAX_AGE_MS) } }] },
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
