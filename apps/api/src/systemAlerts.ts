import { getSetting, logError } from "./db.js";
import { sendTelegramMessage, techChatIds } from "./telegram.js";
import { shouldSendAlert, ALERT_SUSTAINED_MS } from "./alertGate.js";

/**
 * ПРЯМАЯ ТРЕВОГА БЕЗ ДЕДУПА — владельцу и в чат сводок.
 *
 * Для случаев, где каждое срабатывание важно само по себе: сторож входящих,
 * зависшая фоновая задача, отказ воронки на конкретном человеке. Отказ
 * отправки НЕ глотается: раньше здесь стояло `.catch(() => {})`, и если
 * токен бота отозван или чат заблокировал бота, все тревоги проекта уходили
 * в никуда без единого следа (разбор надёжности 03.09.2026). Теперь это
 * попадает в журнал — а журнал виден в панели.
 */
export async function notifyOwnerDirect(
  text: string,
  opts: { dedupeKey?: string; cooldownMs?: number } = {}
): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  // Только технический получатель (владелец), не сестра (08.11.2026).
  const unique = await techChatIds();
  if (unique.length === 0) return;
  // dedupeKey — один и тот же алерт не чаще раза в 6 часов (по умолчанию).
  if (opts.dedupeKey && !(await shouldSendAlert(opts.dedupeKey, { cooldownMs: opts.cooldownMs }))) return;
  for (const chatId of unique) {
    await sendTelegramMessage(botToken, chatId, text).catch((err) => logError("systemAlerts:send", err));
  }
}

/**
 * ХОЗЯЙКЕ — СРАЗУ, НЕ ДОЖИДАЯСЬ ВЕЧЕРНЕЙ СВОДКИ, НО ТОЛЬКО НА НОВЫЙ ВИД
 * ПОЛОМКИ (30.08.2026, по образцу Royal Home CRM: apps/api/src/push.ts,
 * notifyDirectorsAboutNewError).
 *
 * Живёт отдельным файлом, а не в db.ts: тот модуль зовёт эту функцию через
 * крючок (onNewSystemError, регистрируется в index.ts) — прямой импорт
 * telegram.ts из db.ts создал бы цикл, потому что telegram.ts сам импортирует
 * logError из db.ts.
 */
const SOURCE_LABELS: Record<string, string> = {
  ai: "ИИ-ответ",
  "webhook:message": "приём сообщения",
  "webhook:comment": "приём комментария",
  "webhook:signature": "подпись вебхука Meta",
  "aiReplyRetry:queue": "очередь повторов ИИ",
  "receiptRetry": "проверка чеков",
  unhandledRejection: "необработанная ошибка",
  uncaughtException: "падение процесса",
};

export async function notifyOwnerOfSystemError(source: string, message: string): Promise<void> {
  try {
    const botToken = (await getSetting("telegramBotToken"))?.trim();
    if (!botToken) return;

    // Только владелец (08.11.2026): сестре техника не нужна. И только если сбой
    // длится дольше 30 минут (перезапуск моста, обрыв сети — не повод будить);
    // один и тот же сбой — не чаще раза в 6 часов.
    const unique = await techChatIds();
    if (unique.length === 0) return;
    if (!(await shouldSendAlert(`sys:${source}:${message.slice(0, 80)}`, { sustainedMs: ALERT_SUSTAINED_MS }))) return;

    const label = SOURCE_LABELS[source] ?? source;
    const text = `⚠️ Новая проблема в боте (${label})\n${message.slice(0, 300)}`;
    for (const chatId of unique) {
      // Отказ отправки — в консоль, а не в logError: тот снова позвал бы этот
      // же крючок, и при мёртвом Telegram получился бы бесконечный круг.
      await sendTelegramMessage(botToken, chatId, text).catch((err) =>
        console.error(`[systemAlerts:send] ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  } catch {
    // Уведомление не должно ронять запись самой ошибки.
  }
}

/**
 * ЧЕЛОВЕК ИЗ РЕКЛАМЫ ТАК И НЕ ПОЛУЧИЛ ОТВЕТ — ПЕРСОНАЛЬНАЯ ТРЕВОГА, А НЕ ОБЩИЙ
 * ДЕДУП (30.08.2026).
 *
 * `notifyOwnerOfSystemError` намеренно молчит на повтор уже известного вида
 * поломки — это верно для технических ошибок («опять не отвечает Instagram
 * API»), но неверно здесь: каждый такой случай — это ДРУГОЙ, конкретный
 * человек, которого мы теряем, и про КАЖДОГО стоит узнать отдельно, даже если
 * причина отказа технически одна и та же. Отправляется напрямую, без дедупа.
 */
export async function notifyFunnelGaveUp(who: string, attempts: number, lastError: string | null): Promise<void> {
  try {
    await notifyOwnerDirect(
      `🚨 ${who} написал(а) с рекламы, воронка ${attempts} раз не смогла отправить ответ и сдалась.\n` +
        `Человек НЕ получил ничего — посмотрите вручную (Журнал → Сбои). ` +
        `Такие сообщения приходят не чаще раза в 6 часов.` +
        (lastError ? `\nПричина: ${lastError.slice(0, 200)}` : ""),
      // Одна и та же причина (например, истёкший маркер Instagram) — одно
      // сообщение в 6 часов, а не по алерту на каждого человека (08.11.2026).
      { dedupeKey: `funnel-gaveup:${(lastError ?? "").slice(0, 60)}` }
    );
  } catch {
    // Уведомление не должно ронять саму обработку отказа.
  }
}
