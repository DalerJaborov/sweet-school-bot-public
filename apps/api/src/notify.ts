import { getSetting, logError } from "./db.js";
import { sendTelegramMessage, chatsForKind } from "./telegram.js";
import { shouldSendAlert } from "./alertGate.js";
import { NOTIFY_INFO, type NotifyKind } from "./notifyKinds.js";

/**
 * ОДНА ДВЕРЬ ДЛЯ УВЕДОМЛЕНИЙ В TELEGRAM (11.11.2026).
 *
 * Всё, что бот сам пишет владельцу или Ширин «просто так», идёт через sendKind:
 * вид сообщения решает, КОМУ оно уходит (telegram.ts chatsForKind: роли, «только
 * владельцу», выключенные виды), а под каждым сообщением стоит кнопка
 * «🔕 Не присылать такое». Прямой sendTelegramMessage на чат владельца в новых
 * местах не нужен — это ловит тест architecture (tests/unit/notifyArchitecture).
 *
 * Не сюда: ответы на команды человека в личном чате (меню, «выдать ссылку») —
 * они идут тому, кто спросил.
 */
export const MUTE_BUTTON_PREFIX = "nf:off:";

export function muteMarkup(kind: NotifyKind): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: [[{ text: "🔕 Не присылать такое", callback_data: `${MUTE_BUTTON_PREFIX}${kind}` }]] };
}

export type SendKindOptions = {
  /** Один и тот же ключ — не чаще раза в cooldownMs (по умолчанию 6 часов, alertGate.ts). */
  dedupeKey?: string;
  cooldownMs?: number;
  /** Сбой должен идти непрерывно не меньше этого времени (alertGate.ts). */
  sustainedMs?: number;
  /** Ошибки отправки — в консоль, а не в журнал: журнал сам зовёт уведомление о сбоях, получился бы круг. */
  quietErrors?: boolean;
  /** Свои кнопки под сообщением (быстрые ответы, «Разрешить перенос»); «🔕» добавляется ниже, кроме невыключаемых видов. */
  buttons?: { text: string; callback_data: string }[][];
};

type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

function markupFor(kind: NotifyKind, buttons: SendKindOptions["buttons"]): Markup | undefined {
  const rows = [...(buttons ?? []), ...(NOTIFY_INFO[kind].locked ? [] : muteMarkup(kind).inline_keyboard)];
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/** Отправить уведомление нужного вида. Возвращает, скольким чатам ушло. */
export async function sendKind(kind: NotifyKind, text: string, opts: SendKindOptions = {}): Promise<number> {
  const botToken = (await getSetting("telegramBotToken"))?.trim();
  if (!botToken) return 0;
  const recipients = await chatsForKind(kind);
  if (recipients.length === 0) return 0;
  if (
    (opts.dedupeKey || opts.sustainedMs) &&
    !(await shouldSendAlert(`${kind}:${opts.dedupeKey ?? ""}`, {
      cooldownMs: opts.cooldownMs,
      sustainedMs: opts.sustainedMs,
    }))
  ) {
    return 0;
  }
  let sent = 0;
  for (const chatId of recipients) {
    try {
      await sendTelegramMessage(botToken, chatId, text, undefined, markupFor(kind, opts.buttons));
      sent += 1;
    } catch (err) {
      if (opts.quietErrors) console.error(`[notify:${kind}] ${err instanceof Error ? err.message : String(err)}`);
      else logError(`notify:${kind}`, err);
    }
  }
  return sent;
}
