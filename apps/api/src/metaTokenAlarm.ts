import { getSetting, logWarn, setSetting } from "./db.js";
import { sendKind } from "./notify.js";

/**
 * ТРЕВОГА «КЛЮЧ META УМЕР» — В МОМЕНТ ОТКАЗА, А НЕ ПО РАСПИСАНИЮ.
 *
 * ЗАЧЕМ. 12.11.2026 в CRM Royal Home владелец сменил пароль, личный ключ
 * Instagram стал отвечать 401 «session invalidated», и бот сутки молчал для всех
 * клиентов — никто не узнал, пока не спросили. Сторожа по расписанию
 * (igTokenWatch, fbTokenWatch) видят такую смерть с опозданием до 6–12 часов.
 * Здесь — сразу: первая же отправка, на которую Meta ответила 401 или кодом 190,
 * будит владельца.
 *
 * Не чаще раза в 3 часа на каждый ключ: отказ повторяется на каждом сообщении.
 */

export type MetaTokenKey = "igToken" | "fbPageToken";

const COOLDOWN_MS = 3 * 3_600_000;

export const DEAD_TOKEN_TEXT: Record<MetaTokenKey, string> = {
  igToken:
    "🔴 Ключ Instagram больше не принимается (Meta: ключ недействителен). Бот не может отвечать в Instagram.\n" +
    "Частая причина — сменили пароль Instagram или вышли из всех устройств.\n\n" +
    "Быстро: developers.facebook.com → приложение → Instagram → «API setup with Instagram login» → Generate token, " +
    "вставить в админке: Настройки → «Маркер доступа Instagram».\n" +
    "Навсегда: ключ Страницы от системного пользователя shirin-bot (с правом instagram_manage_messages) " +
    "и в Настройках выбрать «Instagram: через Страницу Facebook» — тогда смена пароля бота не ломает.",
  fbPageToken:
    "🔴 Ключ Страницы Facebook больше не принимается (Meta: ключ недействителен). " +
    "Не работают Messenger и всё, что идёт через Страницу.\n" +
    "Частая причина — ключ был выпущен от личного профиля, а пароль сменили.\n\n" +
    "Навсегда: business.facebook.com → Настройки компании → Пользователи → Системные пользователи → shirin-bot → " +
    "«Создать маркер» (приложение Shirin Sweets Bot, срок «Никогда», права pages_messaging, pages_manage_metadata, " +
    "pages_show_list, instagram_basic, instagram_manage_messages, instagram_manage_comments), затем по нему взять " +
    "ключ Страницы и вставить в админке: Настройки → «Маркер страницы Facebook».",
};

/** Отказ отправки с признаком «ключ мёртв» — предупредить владельца (с паузой). */
export async function reportDeadMetaToken(key: MetaTokenKey, now = Date.now()): Promise<boolean> {
  const stampKey = `${key}DeadAlertAt`;
  const last = Number(await getSetting(stampKey));
  if (Number.isFinite(last) && last > 0 && now - last < COOLDOWN_MS) return false;
  await setSetting(stampKey, String(now));
  logWarn("metaToken", `${key}: Meta отвергла ключ`);
  await sendKind("failure", DEAD_TOKEN_TEXT[key]);
  return true;
}

/** Instagram ходит через Страницу Facebook (ключ системного пользователя), а не через Instagram Login. */
export async function instagramViaPage(): Promise<boolean> {
  return (await getSetting("igSendVia"))?.trim() === "page";
}
