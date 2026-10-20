/**
 * Суточный предел на расход ИИ — тот же принцип, что в основной CRM
 * (lib/aiDailyBudget.ts): без границы один настойчивый человек может выжечь
 * весь месячный бюджет Gemini за один вечер, гоняя бота вопросами.
 *
 * Проект маленький, отдельного экрана «Здоровье системы» под него нет — поэтому
 * лимит здесь сразу жёсткий (останавливает), а не мягкий (только пишет в лог).
 * Счётчики живут в Setting как JSON — своя таблица под это не нужна.
 */
import { getSetting, setSetting, logInfo } from "../db.js";
import { notifyOwnerDirect } from "../systemAlerts.js";

/**
 * Пределы на СУТКИ. Подняты 21.08 по решению владельца: в дни с запущенной
 * рекламой людей приходит кратно больше, и упереться в потолок посреди наплыва
 * дороже, чем переплатить за Gemini.
 *
 * Меняются из Настроек без пересборки (`aiDailyLimitGlobal`,
 * `aiDailyLimitContact`) — под большую кампанию можно поднять на день.
 */
const GLOBAL_DAILY_LIMIT = 1000;
const CONTACT_DAILY_LIMIT = 60;

/** Число из настроек. `Number(null)` в JavaScript равен НУЛЮ, а не NaN, — без
 *  этой проверки пустая настройка обнулила бы лимит и бот замолчал бы совсем. */
async function limitFrom(key: string, fallback: number): Promise<number> {
  const raw = (await getSetting(key))?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type Counters = Record<string, number>;

async function readCounters(key: string): Promise<Counters> {
  const raw = await getSetting(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Counters;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/** Сколько ходов ИИ сделано сегодня и каков потолок — для строки состояния
 *  на главном экране панели (today.ts). */
export async function globalAiUsageToday(): Promise<{ calls: number; limit: number }> {
  const global = await readCounters(`aiBudget:global:${today()}`);
  return { calls: global.calls ?? 0, limit: await limitFrom("aiDailyLimitGlobal", GLOBAL_DAILY_LIMIT) };
}

/** true — лимит исчерпан, ходить в ИИ сегодня для этого счёта нельзя. */
export async function isBudgetExceeded(contactId: string): Promise<boolean> {
  const day = today();
  const global = await readCounters(`aiBudget:global:${day}`);
  if ((global.calls ?? 0) >= (await limitFrom("aiDailyLimitGlobal", GLOBAL_DAILY_LIMIT))) return true;

  const perContact = await readCounters(`aiBudget:contact:${day}`);
  return (perContact[contactId] ?? 0) >= (await limitFrom("aiDailyLimitContact", CONTACT_DAILY_LIMIT));
}

/**
 * ТРЕВОГА ВЛАДЕЛЬЦУ НА 80% И 100% СУТОЧНОГО ЛИМИТА (05.09.2026).
 *
 * Раньше об исчерпании квоты не знал никто: директ получал «напишите завтра»,
 * комментарии и чат приложения замолкали, а в панели это выглядело как
 * «Gemini сломался». Два порога — заранее (ещё можно поднять лимит в
 * Настройках или добавить ключ в geminiKeysExtra) и по факту. Каждый уходит
 * один раз в сутки: отметка лежит в тех же суточных счётчиках, что и число
 * вызовов, и обнуляется вместе с ними в полночь.
 */
const ALERT_THRESHOLDS = [80, 100] as const;

function budgetAlertText(percent: (typeof ALERT_THRESHOLDS)[number], calls: number, limit: number): string {
  if (percent >= 100) {
    return (
      `🔴 Gemini: суточный лимит исчерпан — ${calls} из ${limit} вызовов. ` +
      `Бот в директе, под роликами и в чате приложения до полуночи (UTC) отвечает заглушкой «напишите завтра». ` +
      `Если это наплыв с рекламы — поднимите «aiDailyLimitGlobal» в Настройках.`
    );
  }
  return (
    `🟠 Gemini: израсходовано ${percent}% суточного лимита — ${calls} из ${limit} вызовов. ` +
    `На 100% бот замолчит до полуночи. Запас — «aiDailyLimitGlobal» в Настройках, второй ключ — «geminiKeysExtra».`
  );
}

/** Списывает один ход ИИ. Вызывать только после успешного ответа модели. */
export async function recordAiCall(contactId: string): Promise<void> {
  const day = today();

  const globalKey = `aiBudget:global:${day}`;
  const global = await readCounters(globalKey);
  global.calls = (global.calls ?? 0) + 1;
  const limit = await limitFrom("aiDailyLimitGlobal", GLOBAL_DAILY_LIMIT);
  const due = ALERT_THRESHOLDS.filter((p) => !global[`alerted${p}`] && global.calls >= Math.ceil((limit * p) / 100));
  // Отметка о тревоге пишется ВМЕСТЕ со счётчиком, до отправки: отказ
  // Telegram не должен превращаться в тревогу на каждом следующем ходе.
  for (const p of due) global[`alerted${p}`] = 1;
  await setSetting(globalKey, JSON.stringify(global));
  for (const p of due) {
    const text = budgetAlertText(p, global.calls, limit);
    logInfo("aiBudget:alert", text);
    await notifyOwnerDirect(text);
  }

  const contactKey = `aiBudget:contact:${day}`;
  const perContact = await readCounters(contactKey);
  perContact[contactId] = (perContact[contactId] ?? 0) + 1;
  await setSetting(contactKey, JSON.stringify(perContact));
}
