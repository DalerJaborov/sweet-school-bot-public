import { NOTIFY_KINDS, NOTIFY_INFO, type NotifyKind } from "./notifyKinds.js";

/**
 * ПРОСТЫЕ СЛОВА ВЛАДЕЛЬЦА → ДЕЙСТВИЕ (11.11.2026). Без ИИ: короткие правила.
 *
 * «не присылай мне оплаты», «выключи бота», «что у меня выключено», «включи
 * обратно». Когда слова не однозначны («выключи бота» — это ответы людям,
 * пауза или всё сразу?), разбор возвращает `ask…`, а чат переспрашивает кнопками
 * (telegramControl.ts). Чистая функция — проверяется тестами без Telegram.
 */
export type OwnerIntent =
  | { type: "mute"; kinds: NotifyKind[] }
  | { type: "askMute" }
  | { type: "unmute"; kinds: NotifyKind[] }
  | { type: "unmuteAll" }
  | { type: "whatOff" }
  | { type: "ai"; on: boolean }
  | { type: "freeze"; on: boolean }
  | { type: "funnels"; on: boolean }
  | { type: "comments"; on: boolean }
  | { type: "askBotOff" }
  | { type: "botOn" }
  | { type: "menu" };

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,!?;:()«»"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Какие виды уведомлений названы в тексте. «Бот», «клиент» и подобные не считаются. */
export function kindsInText(text: string): NotifyKind[] {
  const t = norm(text);
  return NOTIFY_KINDS.filter((k) => NOTIFY_INFO[k].words.test(t));
}

const NO_SEND =
  /(^| )(не (присылай|присылать|отправляй|отправлять|шли|слать|пиши|писать|показывай|показывать|уведомляй|уведомлять|беспокой)|хватит (присылать|слать|писать|отправлять)|перестан\w+ (присылать|слать|писать|отправлять)|больше не (присылай|присылать|пиши|писать|отправляй))/;
const TURN_OFF = /(^| )(выключи|отключи|убери|вырубь|заглуши|останови|остановить|выключить|отключить|стоп|хватит)( |$)/;
const TURN_ON = /(^| )(включи|включить|запусти|запустить|верни|вернуть|возобнови|продолжи|сними|снять|разреши)( |$)/;
const NOTIF_WORD = /уведомлен|сообщен|присыл|такое|это |этого|такие|нотификаци/;
const BOT_WORD = /(^| )(бот|бота|боту|ботом|бот-?а)( |$)/;
const AI_WORD = /(^| )(ии|ai|ответы|ответ|автоответ\w*|помощник\w*|консультант\w*)( |$)|нейросет/;
const FUNNEL_WORD = /воронк|рилс|рекламу|рекламн/;
const PAUSE_WORD = /пауз/;
const COMMENT_WORD = /комментар|коммент/;

export function parseOwnerCommand(raw: string): OwnerIntent | null {
  const t = norm(raw);
  if (!t || t.length > 160) return null;

  if (/^(меню|menu|управление|кнопки|пульт)$/.test(t)) return { type: "menu" };
  if (/что (у меня )?выключено|какие (уведомлен\w+ )?(у меня )?выключен|что я выключил|покажи выключенное/.test(t))
    return { type: "whatOff" };

  const off = TURN_OFF.test(t) || NO_SEND.test(t);
  const on = TURN_ON.test(t);

  // --- управление ботом: «выключи бота», «включи ии», «сними паузу», «поставь воронку на паузу» ---
  const botish =
    BOT_WORD.test(t) || AI_WORD.test(t) || FUNNEL_WORD.test(t) || PAUSE_WORD.test(t) || COMMENT_WORD.test(t);
  const notifish = NOTIF_WORD.test(t);
  if (botish && !(notifish && !BOT_WORD.test(t))) {
    if (PAUSE_WORD.test(t)) {
      if (/сними|снять|убери|выключи|отключи|продолжи|возобнови|без пауз/.test(t)) return { type: "freeze", on: false };
      if (/постав|включи|на пауз|сделай|нужна/.test(t) || /(^| )пауза( |$)/.test(t)) {
        return FUNNEL_WORD.test(t) ? { type: "funnels", on: false } : { type: "freeze", on: true };
      }
    }
    if (COMMENT_WORD.test(t)) {
      if (off || /не отвечай/.test(t)) return { type: "comments", on: false };
      if (on) return { type: "comments", on: true };
    }
    if (FUNNEL_WORD.test(t)) {
      if (off) return { type: "funnels", on: false };
      if (on) return { type: "funnels", on: true };
    }
    if (/не отвечай( людям| клиентам| им| больше)?$/.test(t) || (AI_WORD.test(t) && off && !BOT_WORD.test(t)))
      return { type: "ai", on: false };
    if (AI_WORD.test(t) && on && !BOT_WORD.test(t)) return { type: "ai", on: true };
    if (BOT_WORD.test(t)) {
      // «не отправляй бот ...» без уведомлений — всё равно про бота
      if (off) return { type: "askBotOff" };
      if (on) return { type: "botOn" };
    }
  }

  // «не пиши клиентам» без названного вида — это про бота, а не про уведомления.
  if (NO_SEND.test(t) && /клиент|людям|людей|ученица|ученицам/.test(t) && kindsInText(t).length === 0)
    return { type: "askBotOff" };

  // --- уведомления: «не присылай мне оплаты», «включи обратно» ---
  if (NO_SEND.test(t) || (TURN_OFF.test(t) && (notifish || kindsInText(t).length > 0))) {
    const kinds = kindsInText(t);
    return kinds.length > 0 ? { type: "mute", kinds } : { type: "askMute" };
  }
  if (on || /(^| )(присылай|отправляй|пиши)( |$)/.test(t)) {
    const kinds = kindsInText(t);
    if (kinds.length > 0 && (notifish || on || /присылай|отправляй|пиши/.test(t))) return { type: "unmute", kinds };
    if (/обратно|уведомлен|как раньше|назад/.test(t)) return { type: "unmuteAll" };
  }
  return null;
}
