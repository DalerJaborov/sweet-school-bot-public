import { getSetting, logInfo, logWarn, setSetting } from "./db.js";
import { sendKind } from "./notify.js";

/**
 * СТОРОЖ МАРКЕРА СТРАНИЦЫ FACEBOOK (fbPageToken).
 *
 * ЗАЧЕМ. Маркер страницы сам не истекает (expires_at = 0), поэтому за ним никто не
 * следил. Но у него есть вторая дата: data_access_expires_at — после неё Meta
 * перестаёт отдавать приложению данные, и ответы на комментарии и ссылки на посты
 * молча ломаются, пока владелец заново не выдаст доступ. Узнать об этом заранее
 * можно только спросив Meta (debug_token), что и делаем раз в 12 часов.
 *
 * Тревога владельцу в Telegram: маркер недействителен, истекает или доступ к
 * данным кончается в ближайшие 7 дней. Не чаще раза в 12 часов.
 */

const DAY = 86_400_000;
const WARN_BEFORE_MS = 7 * DAY;
const ALERT_COOLDOWN_MS = 12 * 3_600_000;
const GRAPH_DEBUG_URL = "https://graph.facebook.com/v21.0/debug_token";

export type FbTokenInfo = {
  is_valid?: boolean;
  /** Секунды Unix; 0 — маркер бессрочный. */
  expires_at?: number;
  /** Секунды Unix; после этой даты Meta перестаёт отдавать данные приложению. */
  data_access_expires_at?: number;
};

const HOW_TO_RENEW =
  "Как продлить: developers.facebook.com → приложение → Messenger/Instagram → «Generate token» для страницы школы " +
  "(или бессрочный маркер системного пользователя в Business Settings → System users), затем вставить в админке: " +
  "Настройки → маркер страницы Facebook.";

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long", year: "numeric" });
}

/** Что с маркером: null — всё хорошо, иначе текст тревоги (уровень уже в тексте). */
export function assessFbToken(info: FbTokenInfo, now: number): string | null {
  if (info.is_valid === false) {
    return "🔴 Маркер страницы Facebook недействителен — ответы на комментарии и ссылки на посты не работают.\n\n" + HOW_TO_RENEW;
  }
  const soonest = [info.expires_at, info.data_access_expires_at]
    .filter((s): s is number => typeof s === "number" && s > 0)
    .map((s) => s * 1000)
    .sort((a, b) => a - b)[0];
  if (soonest === undefined) return null;
  if (soonest <= now) {
    return `🔴 У маркера страницы Facebook закончился доступ к данным (${formatDate(soonest)}) — часть функций бота перестала работать.\n\n${HOW_TO_RENEW}`;
  }
  if (soonest - now <= WARN_BEFORE_MS) {
    return `🟠 У маркера страницы Facebook доступ к данным заканчивается ${formatDate(soonest)}. Продлите заранее, иначе ответы на комментарии остановятся.\n\n${HOW_TO_RENEW}`;
  }
  return null;
}

async function fetchInfo(token: string): Promise<FbTokenInfo | null> {
  const url = `${GRAPH_DEBUG_URL}?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => null)) as { data?: FbTokenInfo; error?: { code?: number } } | null;
  if (body?.data) return body.data;
  // Код 190 — Meta сама говорит, что маркер недействителен.
  if (body?.error?.code === 190) return { is_valid: false };
  throw new Error(`debug_token ${res.status}`);
}

async function alertOwner(text: string, now: number): Promise<void> {
  const last = Number(await getSetting("fbTokenAlertAt"));
  if (Number.isFinite(last) && last > 0 && now - last < ALERT_COOLDOWN_MS) return;
  await setSetting("fbTokenAlertAt", String(now));
  await sendKind("failure", text);
}

/** Раз в несколько часов: спросить Meta про маркер страницы и предупредить заранее. */
export async function checkFbToken(now = Date.now()): Promise<void> {
  const token = (await getSetting("fbPageToken"))?.trim();
  if (!token) return;
  let info: FbTokenInfo | null;
  try {
    info = await fetchInfo(token);
  } catch (err) {
    // Сеть или временный сбой Meta — это не повод будить владельца; повторим через 12 часов.
    logWarn("fbToken", `не удалось проверить маркер страницы: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!info) return;
  const alert = assessFbToken(info, now);
  if (alert) {
    logWarn("fbToken", alert.split("\n")[0]);
    await alertOwner(alert, now);
    return;
  }
  const until = info.data_access_expires_at ? formatDate(info.data_access_expires_at * 1000) : "бессрочно";
  logInfo("fbToken", `маркер страницы в порядке, доступ к данным до: ${until}`);
}
