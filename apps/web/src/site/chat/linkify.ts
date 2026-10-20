/**
 * Разбор текста сообщения на куски «текст / ссылка». Ссылка на платформу
 * (/l/<код> на нашем домене) помечается отдельно: её фронт рисует крупной
 * кнопкой — это главное, ради чего человек пришёл в чат.
 */

export type TextPart = { kind: "text"; value: string } | { kind: "link"; href: string; label: string; platform: boolean };

const URL_RE = /((?:https?:\/\/)[^\s<>()]+[^\s<>().,!?:;'"])|(\/l\/[A-Za-z0-9_-]{4,})/g;

export function linkify(text: string, origin: string = typeof location !== "undefined" ? location.origin : ""): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: "text", value: text.slice(last, start) });
    const raw = m[0];
    const href = raw.startsWith("/") ? `${origin}${raw}` : raw;
    parts.push({ kind: "link", href, label: raw, platform: isPlatformLink(href, origin) });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

export function isPlatformLink(href: string, origin: string): boolean {
  try {
    const u = new URL(href, origin || "http://localhost");
    if (!/^\/l\/[A-Za-z0-9_-]{4,}$/.test(u.pathname)) return false;
    return !origin || u.origin === origin || /shirinsweets\.online$/i.test(u.hostname);
  } catch {
    return false;
  }
}
