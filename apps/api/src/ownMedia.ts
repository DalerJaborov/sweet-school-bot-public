import { getSetting, logError } from "./db.js";
import { env } from "./env.js";

/**
 * Собственные публикации школы — чтобы бот узнавал СВОИ рилсы и истории.
 *
 * ЗАЧЕМ. Когда человек пересылает боту наш рилс и спрашивает «а сколько стоит?»,
 * Meta присылает в вебхуке НЕ файл, а адрес публикации. Скачать по нему нечего —
 * там веб-страница, а не видео. Зато у нас есть собственная лента (`/me/media`),
 * и в ней Graph отдаёт и подпись, и прямую ссылку на файл СВОИХ публикаций. То
 * есть узнать пересланное можно — просто идти за ним надо не по присланному
 * адресу, а в свою ленту, сопоставив короткий код из ссылки.
 *
 * ЧУЖОЙ РОЛИК — МОЛЧАНИЕ. Если код в ленте не нашёлся, это чужая публикация:
 * посмотреть её мы не можем (Meta не отдаёт чужие файлы), а гадать по пустому
 * пересланному видео — значит выдумывать. Решение владельца: молчать.
 */

const GRAPH_VERSION = "v23.0";
const GRAPH_ORIGIN = "https://graph.instagram.com";
/** Лента живёт в памяти три минуты: свежий рилс успевает разойтись по
 *  подписчикам быстрее, чем истекает более долгий кэш, и бот «не знал» бы о нём. */
const FEED_MAX_AGE_MS = 3 * 60_000;
const FEED_LIMIT = 100;

export interface OwnMedia {
  id: string;
  permalink: string;
  caption?: string;
  /** Прямая ссылка на файл. У видео Graph отдаёт её только владельцу аккаунта. */
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaType: string;
}

let cache: { items: OwnMedia[]; at: number } | null = null;

/** Короткий код публикации из ссылки: instagram.com/reel/<КОД>/ */
export function instagramShortcode(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

type RawMedia = { id?: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string };

function buildUrl(path: string, fields: string, token: string): { url: string; headers: Record<string, string> } {
  const url = env.igProxyBase
    ? `${env.igProxyBase}${path}?fields=${fields}&limit=${FEED_LIMIT}&access_token=${encodeURIComponent(token)}`
    : `${GRAPH_ORIGIN}${path}?fields=${fields}&limit=${FEED_LIMIT}`;
  const headers: Record<string, string> = env.igProxyBase
    ? env.igProxyKey
      ? { "x-proxy-key": env.igProxyKey }
      : {}
    : { Authorization: `Bearer ${token}` };
  return { url, headers };
}

async function fetchEdge(path: string, tag: string, requirePermalink: boolean): Promise<OwnMedia[] | null> {
  const token = (await getSetting("igToken"))?.trim();
  if (!token) return null;

  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
  const { url, headers } = buildUrl(path, fields, token);

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Instagram API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { data?: RawMedia[] };
    return (data.data ?? [])
      .filter((m) => m.id && (!requirePermalink || m.permalink))
      .map((m) => ({
        id: m.id as string,
        permalink: m.permalink ?? "",
        caption: m.caption,
        mediaUrl: m.media_url,
        thumbnailUrl: m.thumbnail_url,
        mediaType: m.media_type ?? "",
      }));
  } catch (err) {
    logError(tag, err);
    return null;
  }
}

/**
 * ИСТОРИИ — ОТДЕЛЬНАЯ ЛЕНТА. `/me/media` отдаёт только постоянные публикации
 * (посты, рилсы) — АКТИВНЫЕ ИСТОРИИ в неё не попадают вообще, у них свой edge
 * `/me/stories`, и они видны там только 24 часа, пока не исчезли. Раньше
 * запрашивалась только `/me/media` — ответ на СВОЮ же историю бот принимал за
 * чужой ролик и молчал (см. ЧУЖОЙ РОЛИК — МОЛЧАНИЕ ниже): человек написал по
 * делу, а бот не увидел вообще ничего, даже в базу разговор не попадал.
 * У историй чаще всего нет `permalink` — сопоставляем их по `id`
 * (msg.reply_to.story.id из вебхука), не по ссылке.
 */
async function fetchFeed(): Promise<OwnMedia[] | null> {
  return fetchEdge(`/${GRAPH_VERSION}/me/media`, "ownMedia:feed", true);
}

async function fetchStories(): Promise<OwnMedia[] | null> {
  return fetchEdge(`/${GRAPH_VERSION}/me/stories`, "ownMedia:stories", false);
}

async function feed(): Promise<OwnMedia[] | null> {
  if (cache && Date.now() - cache.at < FEED_MAX_AGE_MS) return cache.items;
  const [posts, stories] = await Promise.all([fetchFeed(), fetchStories()]);
  // Свежую ленту не получили — отдаём прошлую, если она есть: устаревшая лента
  // лучше, чем «не узнал свой же ролик» из-за секундного сбоя сети.
  if (!posts && !stories) return cache?.items ?? null;
  const items = [...(posts ?? []), ...(stories ?? [])];
  cache = { items, at: Date.now() };
  return items;
}

/** Наша ли это публикация — ищем по короткому коду из ссылки или по её id. */
export async function findOwnMedia(input: { url?: string | null; mediaId?: string | null }): Promise<OwnMedia | null> {
  const items = await feed();
  if (!items) return null;

  if (input.mediaId) {
    const byId = items.find((m) => m.id === input.mediaId);
    if (byId) return byId;
  }
  const code = instagramShortcode(input.url);
  if (!code) return null;
  return items.find((m) => instagramShortcode(m.permalink) === code) ?? null;
}

/**
 * Что из публикации можно показать модели ГЛАЗАМИ.
 *
 * У видео берём обложку, а не сам файл: ролик весит десятки мегабайт, разбирается
 * несколько секунд и стоит денег, а обложка вместе с подписью отвечает на главный
 * вопрос «о чём это» почти так же полно.
 */
export function viewableUrl(media: OwnMedia): string | undefined {
  if (media.mediaType === "VIDEO") return media.thumbnailUrl ?? media.mediaUrl;
  return media.mediaUrl ?? media.thumbnailUrl;
}
