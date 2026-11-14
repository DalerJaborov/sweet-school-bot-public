import { prisma, logError } from "../db.js";
import { automationBlockKind } from "./automation.js";

/**
 * ОДНА ДВЕРЬ ДЛЯ «НЕ ОТВЕЧАЕМ» (владелец 15.11.2026: «чтобы бот никого не пропускал»).
 *
 * Аудит прод-базы за 7 дней: 84 человека остались без ответа, а журнал решений
 * (ReplyGate) знал только про 41 случай — его писал один фильтр «не по делу».
 * Остальные молчания (пауза после Ширин, «сейчас уточню», реакция-сердечко,
 * [NO_REPLY] модели, сбой отправки, воронка) не оставляли следа: аудит видел
 * «бот молчит», но не видел почему, а сторож не мог отличить решение от потери.
 *
 * Теперь каждое такое решение пишет строку ReplyGate (cls = "policy",
 * source = "code"). Поле action делит их на два вида:
 *   silent — решение окончательное (клиент «личный», модель сказала [NO_REPLY],
 *            реакция вместо ответа): сторож unansweredWatch.ts это уважает;
 *   wait   — ответ отложен (ведёт Ширин, ждём человека, сбой ИИ или отправки):
 *            сторож ответит сам, когда пауза кончится.
 * Причина — закрытый список ниже: опечатку поймает tsc, а не аудит.
 */
export const NO_REPLY_REASONS = {
  // Ответ отложен — сторож подберёт.
  human_takeover: { action: "wait", label: "пауза после живого ответа Ширин" },
  human_requested: { action: "wait", label: "ждём Ширин: клиент просил человека или бот сказал «уточню»" },
  ai_error: { action: "wait", label: "ИИ не ответил, ход в очереди повторов" },
  no_keys: { action: "wait", label: "нет ключей Gemini" },
  policy_held: { action: "wait", label: "ответ задержан проверкой фактов" },
  send_failed: { action: "wait", label: "ход упал: сбой генерации или отправки, ответ не ушёл" },
  unknown: { action: "wait", label: "ответа нет, причина не названа" },
  // Решение молчать — окончательное.
  personal: { action: "silent", label: "личный, спам или сохранённый контакт" },
  followed: { action: "silent", label: "на человека подписана Ширин (знакомые)" },
  abuse: { action: "silent", label: "заблокирован: флирт, оскорбление, спам" },
  looks_personal: { action: "silent", label: "похоже на личную переписку" },
  frozen: { action: "silent", label: "экстренная пауза бота" },
  ai_off: { action: "silent", label: "помощник выключен" },
  offline_handoff: { action: "silent", label: "офлайн-курс передан Ширин" },
  reaction: { action: "silent", label: "«спасибо» — поставили реакцию" },
  guard_silent: { action: "silent", label: "фильтр: молчим нарочно" },
  guard_limit: { action: "silent", label: "фильтр: шаблон уже отправлялся" },
  model_no_reply: { action: "silent", label: "модель: ответа не требуется [NO_REPLY]" },
  filtered_empty: { action: "silent", label: "после фильтров текста не осталось" },
  media_only: { action: "silent", label: "только фото или файл без текста — ждёт разбора чека" },
  funnel_menu_sent: { action: "silent", label: "воронка: меню уже ушло, «салом» без вопроса" },
  funnel_tap_running: { action: "silent", label: "воронка: кнопка уже обрабатывается" },
  funnel_step_scheduled: { action: "silent", label: "воронка: шаг по кнопке уйдёт по расписанию" },
} as const satisfies Record<string, { action: "wait" | "silent"; label: string }>;

export type NoReplyReason = keyof typeof NO_REPLY_REASONS;
export type NoReplyAction = (typeof NO_REPLY_REASONS)[NoReplyReason]["action"];

/** cls строк, которые пишет эта дверь (relevanceGate пишет свои cls — on_topic, greeting…). */
export const NO_REPLY_CLS = "policy";

export function noReplyAction(reason: NoReplyReason): NoReplyAction {
  return NO_REPLY_REASONS[reason].action;
}

/**
 * Записать решение «не отвечаем». Сбой записи не трогает разговор — только журнал.
 * `preview` — начало входящего (до 200 знаков), как у фильтра «не по делу».
 */
export async function recordNoReply(
  contact: { id: string; channel?: string | null },
  reason: NoReplyReason,
  preview: string | null | undefined,
): Promise<void> {
  const { action, label } = NO_REPLY_REASONS[reason];
  try {
    await prisma.replyGate.create({
      data: {
        contactId: contact.id,
        channel: contact.channel ?? "INSTAGRAM",
        cls: NO_REPLY_CLS,
        action,
        source: "code",
        reason: `${reason}: ${label}`.slice(0, 200),
        preview: (preview ?? "").slice(0, 200),
      },
    });
  } catch (err) {
    logError("noReply:record", err);
  }
}

/** Почему дверь отправки (contactAutomationBlocked) не пускает ответ — для журнала. */
export function policyNoReplyReason(contact: Parameters<typeof automationBlockKind>[0], now = Date.now()): NoReplyReason {
  return automationBlockKind(contact, now) ?? "unknown";
}
