import { getSetting, logError } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";

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
export async function notifyOwnerDirect(text: string): Promise<void> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return;
  const recipients = [
    (await getSetting("telegramOwnerChatId"))?.trim(),
    (await getSetting("telegramReportChatId"))?.trim(),
  ].filter((id): id is string => Boolean(id));
  const unique = [...new Set(recipients)];
  if (unique.length === 0) return;
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

    // Оба получателя вечерней сводки (dailyReport.ts) — новая поломка касается
    // и владельца, и сестры одинаково, кто из них первым увидит Telegram.
    const recipients = [
      (await getSetting("telegramOwnerChatId"))?.trim(),
      (await getSetting("telegramReportChatId"))?.trim(),
    ].filter((id): id is string => Boolean(id));
    const unique = [...new Set(recipients)];
    if (unique.length === 0) return;

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
        `Человек НЕ получил ничего — посмотрите вручную (Журнал → Сбои).` +
        (lastError ? `\nПричина: ${lastError.slice(0, 200)}` : "")
    );
  } catch {
    // Уведомление не должно ронять саму обработку отказа.
  }
}
