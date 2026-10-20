import { env } from "../env.js";

const GRAPH_VERSION = "v23.0";
const GRAPH_ORIGIN = "https://graph.instagram.com";

function apiUrl(path: string, params: Record<string, string>, token: string): string {
  const base = env.igProxyBase ? `${env.igProxyBase}/${GRAPH_VERSION}${path}` : `${GRAPH_ORIGIN}/${GRAPH_VERSION}${path}`;
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return url.toString();
}

/**
 * GET-запрос к Instagram API (Instagram Login, graph.instagram.com) — общий для
 * разового импорта переписок (historyImport.ts) и периодической дозаправки
 * пропущенных комментариев (commentBackfill.ts). Оба идут от одного и того же
 * маркера и через один и тот же прокси (см. buildRequest в instagram.ts —
 * это её GET-аналог: та же схема прокси/заголовков, но без POST-тела).
 */
export async function igGet(path: string, params: Record<string, string>, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(path, params, token), {
    headers: env.igProxyKey ? { "x-proxy-key": env.igProxyKey } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Instagram API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}
