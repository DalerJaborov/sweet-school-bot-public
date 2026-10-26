import { createHash } from "node:crypto";
import { getSetting, logInfo, logWarn, prisma, setSetting } from "./db.js";
import { igGet } from "./ai/igGet.js";
import { ownerAlertChatIds, sendTelegramMessage } from "./telegram.js";

/**
 * АВТОПРОДЛЕНИЕ МАРКЕРА INSTAGRAM.
 *
 * ЗАЧЕМ. Долгоживущий маркер Instagram Login живёт 60 дней, и сам бот его не
 * продлевал. 20.10.2026 маркер истёк — шесть дней бот не мог ответить никому:
 * люди с рекламы не получали даже приветствия, а в Telegram сыпались
 * однотипные «Session has expired», из которых не было понятно, что делать.
 *
 * Как работает. Пока маркер жив, его можно бесплатно продлить ещё на 60 дней
 * (refresh_access_token). Meta продлевает только маркер старше суток, поэтому
 * свежевставленный маркер трогаем через сутки, дальше — раз в неделю: запас в
 * восемь попыток до истечения. Если продлить не выходит, за неделю до конца
 * владелец получает понятную тревогу с инструкцией.
 *
 * Состояние хранится в Setting (как остальные отметки задач), чтобы переживать
 * перезапуски. Отпечаток маркера нужен, чтобы заметить, что владелец вставил
 * новый маркер вручную: тогда даты старого маркера к нему не относятся.
 */

const DAY = 86_400_000;
/** Meta не продлевает маркер моложе суток. */
const MIN_AGE_MS = DAY;
/** Как часто продлевать живой маркер. */
const REFRESH_EVERY_MS = 7 * DAY;
/** За сколько до истечения начинаем тревожить владельца. */
const WARN_BEFORE_MS = 7 * DAY;
/** Срок маркера по умолчанию, если дата истечения неизвестна (вставлен вручную). */
const DEFAULT_LIFETIME_MS = 60 * DAY;
/** Тревога — не чаще раза в 12 часов, иначе её перестанут читать. */
const ALERT_COOLDOWN_MS = 12 * 3_600_000;

const K = {
  fingerprint: "igTokenFingerprint",
  obtainedAt: "igTokenObtainedAt",
  refreshedAt: "igTokenRefreshedAt",
  expiresAt: "igTokenExpiresAt",
  lastError: "igTokenLastError",
  alertAt: "igTokenAlertAt",
} as const;

export type TokenState = {
  obtainedAt: number;
  refreshedAt: number | null;
  /** null — срок неизвестен: маркер вставлен вручную и ещё ни разу не продлён. */
  expiresAt: number | null;
};

export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Пора ли продлевать: маркер старше суток и с прошлого продления прошла неделя. */
export function shouldRefresh(s: TokenState, now: number): boolean {
  if (now - s.obtainedAt < MIN_AGE_MS) return false;
  return s.refreshedAt === null || now - s.refreshedAt >= REFRESH_EVERY_MS;
}

/** Когда маркер истечёт: известная дата или оценка «60 дней с момента вставки». */
export function effectiveExpiry(s: TokenState): number {
  return s.expiresAt ?? s.obtainedAt + DEFAULT_LIFETIME_MS;
}

/** Ошибка Meta «маркер недействителен» (код 190): продлевать уже нечего. */
export function isTokenDead(message: string): boolean {
  return /"code"\s*:\s*190\b/.test(message) || /OAuthException/.test(message);
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long" });
}

const HOW_TO_REPLACE =
  "Как заменить: developers.facebook.com → приложение → Instagram → «API setup with Instagram login» → " +
  "Generate token у аккаунта школы, затем вставить в админке: Настройки → «Маркер доступа Instagram».";

function num(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadState(token: string, now: number): Promise<TokenState> {
  const fp = fingerprint(token);
  if ((await getSetting(K.fingerprint)) !== fp) {
    // Владелец вставил другой маркер — начинаем отсчёт заново.
    await setSetting(K.fingerprint, fp);
    await setSetting(K.obtainedAt, String(now));
    await prisma.setting.deleteMany({ where: { key: { in: [K.refreshedAt, K.expiresAt, K.lastError, K.alertAt] } } });
    return { obtainedAt: now, refreshedAt: null, expiresAt: null };
  }
  return {
    obtainedAt: num(await getSetting(K.obtainedAt)) ?? now,
    refreshedAt: num(await getSetting(K.refreshedAt)),
    expiresAt: num(await getSetting(K.expiresAt)),
  };
}

async function alertOwner(text: string, now: number): Promise<void> {
  const last = num(await getSetting(K.alertAt));
  if (last !== null && now - last < ALERT_COOLDOWN_MS) return;
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatId = (await ownerAlertChatIds())[0];
  if (!botToken || !chatId) return;
  await setSetting(K.alertAt, String(now));
  await sendTelegramMessage(botToken, chatId, text);
}

/** Продлевает маркер. Возвращает текст ошибки или null при успехе. */
async function refresh(token: string, now: number): Promise<string | null> {
  let res: Record<string, unknown>;
  try {
    res = await igGet("/refresh_access_token", { grant_type: "ig_refresh_token" }, token);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const fresh = typeof res.access_token === "string" ? res.access_token : "";
  const ttlSec = typeof res.expires_in === "number" ? res.expires_in : 0;
  if (!fresh || ttlSec <= 0) return "Instagram вернул ответ без маркера";

  // Владелец мог вставить новый маркер, пока шёл запрос, — его не затираем.
  const swapped = await prisma.setting.updateMany({ where: { key: "igToken", value: token }, data: { value: fresh } });
  if (swapped.count === 0) return null;
  await setSetting(K.fingerprint, fingerprint(fresh));
  await setSetting(K.obtainedAt, String(now));
  await setSetting(K.refreshedAt, String(now));
  await setSetting(K.expiresAt, String(now + ttlSec * 1000));
  await prisma.setting.deleteMany({ where: { key: { in: [K.lastError, K.alertAt] } } });
  logInfo("igToken", `маркер продлён до ${formatDate(now + ttlSec * 1000)}`);
  return null;
}

/** Раз в несколько часов: продлить маркер, если пора, и предупредить, если не выходит. */
export async function checkIgToken(now = Date.now()): Promise<void> {
  const token = (await getSetting("igToken"))?.trim();
  if (!token) return;

  const state = await loadState(token, now);
  if (!shouldRefresh(state, now)) return;

  const error = await refresh(token, now);
  if (error === null) return;

  await setSetting(K.lastError, error.slice(0, 300));
  logWarn("igToken", `не удалось продлить маркер: ${error.slice(0, 200)}`);

  if (isTokenDead(error)) {
    await alertOwner(
      "🔴 Маркер доступа Instagram недействителен — бот не может отвечать в Instagram, " +
        "люди с рекламы не получают ничего.\n\n" +
        HOW_TO_REPLACE,
      now
    );
    return;
  }

  const expiry = effectiveExpiry(state);
  if (expiry - now <= WARN_BEFORE_MS) {
    await alertOwner(
      `🟠 Маркер доступа Instagram истекает ${formatDate(expiry)}, а продлить его автоматически не получается.\n` +
        `Причина: ${error.slice(0, 200)}\n\n` +
        HOW_TO_REPLACE,
      now
    );
  }
}
