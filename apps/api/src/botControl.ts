import { prisma, getSetting, setSetting } from "./db.js";

/**
 * УПРАВЛЕНИЕ БОТОМ ОДНОЙ ДВЕРЬЮ (11.11.2026): и кнопки в Telegram, и слова
 * владельца («выключи бота»), и панель вызывают только эти функции.
 *
 * Три независимых рубильника, как их знает остальной код:
 *  • ответы ИИ людям — `aiEnabled` (ai.ts); выключен — бот молчит в личных
 *    сообщениях, автоворонка (кнопки, шаги) живёт;
 *  • пауза «всё, кроме воронки» — `botFrozen` (messaging/automation.ts): глушит
 *    выдачу ссылок, напоминания, повторы;
 *  • воронка (рилсы и комментарии) — флажок `enabled` у каждой воронки. Чтобы
 *    потом включить ровно те, что работали, при паузе запоминаем их id.
 * Ответы ИИ под комментариями — свой флаг `aiCommentRepliesEnabled`
 * (по умолчанию включён, только "false" выключает).
 */
const FUNNELS_PAUSED_KEY = "funnelsPausedIds";

export type BotState = {
  /** Отвечает ли ИИ людям в личных сообщениях. */
  ai: boolean;
  /** Пауза «всё, кроме воронки». */
  frozen: boolean;
  /** Отвечает ли ИИ под комментариями. */
  comments: boolean;
  /** Сколько воронок включено сейчас. */
  funnelsOn: number;
  /** Воронки поставлены на паузу кнопкой (есть что возвращать). */
  funnelsPaused: boolean;
};

async function pausedFunnelIds(): Promise<string[]> {
  try {
    const raw = await getSetting(FUNNELS_PAUSED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function getBotState(): Promise<BotState> {
  const [ai, frozen, comments, funnelsOn, paused] = await Promise.all([
    getSetting("aiEnabled"),
    getSetting("botFrozen"),
    getSetting("aiCommentRepliesEnabled"),
    prisma.funnel.count({ where: { enabled: true } }),
    pausedFunnelIds(),
  ]);
  return {
    ai: ai?.trim() === "true",
    frozen: frozen?.trim() === "true",
    comments: comments?.trim() !== "false",
    funnelsOn,
    funnelsPaused: paused.length > 0,
  };
}

export async function setAiReplies(on: boolean): Promise<void> {
  await setSetting("aiEnabled", on ? "true" : "false");
}

export async function setFrozen(on: boolean): Promise<void> {
  await setSetting("botFrozen", on ? "true" : "false");
}

export async function setCommentReplies(on: boolean): Promise<void> {
  await setSetting("aiCommentRepliesEnabled", on ? "true" : "false");
}

/** Выключить воронки, запомнив, какие были включены. Повторный вызов ничего не теряет. */
export async function pauseFunnels(): Promise<number> {
  const on = await prisma.funnel.findMany({ where: { enabled: true }, select: { id: true } });
  if (on.length === 0) return 0;
  const ids = [...new Set([...(await pausedFunnelIds()), ...on.map((f) => f.id)])];
  await setSetting(FUNNELS_PAUSED_KEY, JSON.stringify(ids));
  await prisma.funnel.updateMany({ where: { id: { in: on.map((f) => f.id) } }, data: { enabled: false } });
  return on.length;
}

/** Вернуть именно те воронки, что были включены до паузы. */
export async function resumeFunnels(): Promise<number> {
  const ids = await pausedFunnelIds();
  if (ids.length === 0) return 0;
  const res = await prisma.funnel.updateMany({ where: { id: { in: ids } }, data: { enabled: true } });
  await setSetting(FUNNELS_PAUSED_KEY, "[]");
  return res.count;
}

/** «Выключи бота совсем»: ответы ИИ, всё остальное и воронка. */
export async function stopEverything(): Promise<void> {
  await setAiReplies(false);
  await setFrozen(true);
  await pauseFunnels();
}

/** «Включи бота»: возвращает то, что было выключено (ответы, пауза, воронки). */
export async function startEverything(): Promise<void> {
  await setAiReplies(true);
  await setFrozen(false);
  await resumeFunnels();
}

/** Состояние простыми словами — для кнопок в Telegram и панели. */
export function describeBotState(s: BotState): string[] {
  return [
    `${s.ai ? "🟢" : "🔴"} Ответы бота людям: ${s.ai ? "включены" : "выключены"}`,
    `${s.frozen ? "⏸" : "🟢"} Пауза (всё, кроме воронки): ${s.frozen ? "включена" : "нет"}`,
    `${s.funnelsOn > 0 ? "🟢" : s.funnelsPaused ? "⏸" : "🔴"} Воронка с рилсов: ${
      s.funnelsOn > 0 ? "работает" : s.funnelsPaused ? "на паузе" : "выключена"
    }`,
    `${s.comments ? "🟢" : "🔴"} Ответы под комментариями: ${s.comments ? "включены" : "выключены"}`,
  ];
}
