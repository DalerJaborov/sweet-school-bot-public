import { sendKind } from "./notify.js";
import { ALERT_SUSTAINED_MS } from "./alertGate.js";
import type { NotifyKind } from "./notifyKinds.js";

/**
 * ПРЯМАЯ ТРЕВОГА — ТОЛЬКО ВЛАДЕЛЬЦУ (вид «сбои», если не сказано иное).
 *
 * Для случаев, где каждое срабатывание важно само по себе: зависшая фоновая
 * задача, лимит ИИ, отказ повтора ответа. Отказ отправки НЕ глотается (разбор
 * надёжности 03.09.2026): он попадает в журнал, а журнал виден в панели.
 * Получатели и выключенные виды — в telegram.ts chatsForKind (11.11.2026);
 * Ширин служебного не получает никогда.
 */
export async function notifyOwnerDirect(
  text: string,
  opts: { dedupeKey?: string; cooldownMs?: number; kind?: NotifyKind } = {}
): Promise<void> {
  await sendKind(opts.kind ?? "failure", text, { dedupeKey: opts.dedupeKey, cooldownMs: opts.cooldownMs });
}

/**
 * «ОЖИДАЕМЫЕ» ОТКАЗЫ — НЕ ПОВОД БУДИТЬ ВЛАДЕЛЬЦА (11.11.2026).
 *
 * Бот сам отказывается писать человеку, у которого стоит пауза после ответа
 * Ширин, отметка «знакомый», спам-блок и т. п. (messaging/automation.ts, «contact
 * policy»), а Instagram не пускает писать вне 24-часового окна. Это работа
 * защиты, а не поломка: раньше из-за них приходили «Новая проблема funnel:step
 * Contact messaging blocked» и «воронка 11 раз не смогла отправить и сдалась».
 */
export function isExpectedFailure(message: string | null | undefined): boolean {
  const m = message ?? "";
  return (
    /Contact messaging blocked/i.test(m) ||
    /contact policy/i.test(m) ||
    /Meta delivery WINDOW/i.test(m) ||
    /outside.*(?:window|24)|24.hour.*window/i.test(m) ||
    /Meta delivery (?:RATE|TRANSIENT)/i.test(m)
  );
}

/**
 * Какие внутренние ошибки вообще имеют право стать сообщением. Остальные —
 * только в журнал (панель → «Журнал»): сеть моргнула, один клиент закрыл
 * сообщения, Telegram отклонил чужой запрос. Список короткий и осознанный.
 */
const ALERTING_SOURCES: Record<string, string> = {
  ai: "ИИ-ответ",
  "webhook:message": "приём сообщения",
  "webhook:comment": "приём комментария",
  "webhook:signature": "подпись вебхука Meta",
  "aiReplyRetry:queue": "очередь повторов ИИ",
  "receiptRetry": "проверка чеков",
  unhandledRejection: "необработанная ошибка",
  uncaughtException: "падение процесса",
};

export function systemErrorMayAlert(source: string, message: string): boolean {
  return source in ALERTING_SOURCES && !isExpectedFailure(message);
}

export async function notifyOwnerOfSystemError(source: string, message: string): Promise<void> {
  try {
    if (!systemErrorMayAlert(source, message)) return;
    // Только если сбой длится дольше 30 минут (перезапуск моста, обрыв сети — не
    // повод будить); один и тот же сбой — не чаще раза в 6 часов.
    await sendKind("failure", `⚠️ Новая проблема в боте (${ALERTING_SOURCES[source]})\n${message.slice(0, 300)}`, {
      dedupeKey: `sys:${source}:${message.slice(0, 80)}`,
      sustainedMs: ALERT_SUSTAINED_MS,
      // В журнал нельзя: тот снова позвал бы этот же крючок, и при мёртвом Telegram получился бы бесконечный круг.
      quietErrors: true,
    });
  } catch {
    // Уведомление не должно ронять запись самой ошибки.
  }
}

/**
 * ВОРОНКА СДАЛАСЬ НА ЧЕЛОВЕКЕ. Раньше — по тревоге на каждого. Теперь: молчим,
 * если причина «ожидаемая» (защита, окно Instagram — isExpectedFailure); по
 * настоящей причине (Meta отклоняет, маркер истёк) — одно сообщение на причину
 * раз в 6 часов. Человек при этом виден в панели (Журнал → Сбои).
 */
export async function notifyFunnelGaveUp(who: string, attempts: number, lastError: string | null): Promise<void> {
  try {
    if (isExpectedFailure(lastError)) return;
    await sendKind(
      "failure",
      `🚨 ${who} написал(а) с рекламы, воронка ${attempts} раз не смогла отправить ответ и сдалась.\n` +
        `Посмотрите вручную (Журнал → Сбои).` +
        (lastError ? `\nПричина: ${lastError.slice(0, 200)}` : ""),
      { dedupeKey: `funnel-gaveup:${(lastError ?? "").slice(0, 60)}` }
    );
  } catch {
    // Уведомление не должно ронять саму обработку отказа.
  }
}
