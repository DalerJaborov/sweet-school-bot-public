import { getSetting, setSetting } from "./db.js";
import { ownerAlertChatIds, sendTelegramMessage } from "./telegram.js";

/**
 * СТОРОЖ «СЕКРЕТ ПРИЛОЖЕНИЯ META».
 *
 * ЗАЧЕМ. Без `appSecret` вебхук отклоняет ВСЕ входящие от Meta (webhook.ts,
 * verifySignature): ни комментариев, ни директа, воронка молчит. На новом
 * сервере (07.11.2026) секрет не перенесли — за сутки было 1619 отказов, а
 * владелец узнал об этом только при ручном аудите перед запуском рекламы. Эта
 * ошибка раньше шла лишь в общий журнал, где тонет среди остальных.
 *
 * Что делает. Раз в час проверяет, что секрет задан; если пуст — шлёт
 * владельцу понятную тревогу с инструкцией, не чаще раза в 12 часов. Если
 * некому слать (не задан ни один чат владельца) — это тоже ошибка, о которой
 * говорится в возвращаемом значении, чтобы вызывающий записал её в журнал.
 */
const ALERT_COOLDOWN_MS = 12 * 3_600_000;
const ALERT_KEY = "appSecretAlertAt";

const TEXT =
  "🚨 Бот сейчас не видит ни комментариев, ни сообщений: в настройках пуст «Секрет приложения Meta», " +
  "поэтому все входящие отклоняются. Реклама и воронка не работают.\n\n" +
  "Как исправить: developers.facebook.com → ваше приложение → Settings → Basic → App secret (Show) → " +
  "вставить в админке: Настройки → «Секрет приложения Meta».";

export type SecretCheck = "ok" | "alerted" | "cooldown" | "no-recipient";

export async function checkAppSecret(now = Date.now()): Promise<SecretCheck> {
  if ((await getSetting("appSecret"))?.trim()) return "ok";

  const last = Number(await getSetting(ALERT_KEY));
  if (Number.isFinite(last) && last > 0 && now - last < ALERT_COOLDOWN_MS) return "cooldown";

  const botToken = (await getSetting("telegramBotToken"))?.trim();
  const chatIds = await ownerAlertChatIds();
  if (!botToken || chatIds.length === 0) return "no-recipient";

  await setSetting(ALERT_KEY, String(now));
  for (const chatId of chatIds) await sendTelegramMessage(botToken, chatId, TEXT);
  return "alerted";
}
