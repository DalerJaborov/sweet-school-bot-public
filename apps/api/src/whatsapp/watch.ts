import { getSetting, logWarn, setSetting } from "../db.js";
import { sendKind } from "../notify.js";
import { bridgeRequest, whatsappConfigured } from "./client.js";

/**
 * СТОРОЖ СВЯЗИ С WHATSAPP (08.11.2026; пауза и тревога владельцу — 15.11.2026).
 *
 * Сессия WhatsApp живёт в мосте (services/whatsapp-bridge). Если вход слетел
 * (state pairing / disconnected / auth_failure), мост не отвечает или контакты не
 * загрузились — бот молча перестаёт отвечать в WhatsApp. Раз в минуту спрашиваем
 * статус моста; если плохо ДОЛЬШЕ 10 минут подряд, в панели («Сегодня» → «Что-то
 * работает не так») появляется строка с подсказкой.
 *
 * ПАУЗА — тоже беда, если долгая. 09–13.11.2026 мост 4 дня стоял на паузе: пауза
 * выбрасывает ВСЕ входящие (bridge.cjs `drop:paused`), включая чеки, — и никто не
 * заметил. Мост ставит паузу и сам, без кнопки: ошибка при старте, при разборе
 * сообщения, переполненная очередь. Поэтому пауза дольше `whatsappPauseAlertHours`
 * (по умолчанию 3 ч) — строка в панели и сообщение владельцу.
 *
 * Telegram — НЕ на каждое моргание (11.11.2026 владелец: «📵 WhatsApp отключился»
 * каждые 6 часов — «мусор»). Пишем один раз, когда беда тянется дольше порога
 * (обрыв — 3 ч, пауза — `whatsappPauseAlertHours`), и напоминаем не чаще раза в сутки.
 * Начало беды хранится в настройках, чтобы перезапуск api не обнулял счётчик.
 *
 * Пока WhatsApp ни разу не был подключён (`whatsappEverReady` пуст), молчим: нечему
 * «отключаться». /health сюда НЕ подмешиваем: перезапуск api WhatsApp не лечит, а сторож
 * сервера стал бы перезапускать контейнер впустую.
 */

export const WHATSAPP_SUSTAINED_MS = 10 * 60_000;
export const WHATSAPP_DOWN_ALERT_MS = 3 * 3_600_000;
export const WHATSAPP_PAUSE_ALERT_HOURS_DEFAULT = 3;
export const WHATSAPP_ALERT_REPEAT_MS = 24 * 3_600_000;
const EVER_READY_KEY = "whatsappEverReady";
const SINCE_KEY = "whatsappTroubleSince";
const ALERT_AT_KEY = "whatsappTroubleAlertAt";

type BridgeStatus = { state?: string; contactsReady?: boolean };
type Kind = "down" | "unlinked" | "paused";
let problem: { since: number; kind: Kind } | null = null;
let pauseMs = WHATSAPP_PAUSE_ALERT_HOURS_DEFAULT * 3_600_000;

const HINT = "Настройки → WhatsApp → Подключить.";

function durationText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} мин`;
  if (h < 48) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

function textFor(kind: Kind, forMs: number): string {
  if (kind === "paused") {
    return (
      `WhatsApp на паузе уже ${durationText(forMs)}: бот не видит сообщения и чеки из WhatsApp, они теряются. ` +
      "Включить: Настройки → WhatsApp → «Включить ответы». Если бот должен молчать — включите там же «Только чеки»: " +
      "бот не пишет, а чеки принимаются."
    );
  }
  return kind === "down"
    ? `WhatsApp: мост связи не отвечает уже ${durationText(forMs)}, ответы клиентам и чеки в WhatsApp не идут. Если не пройдёт само — ${HINT}`
    : `WhatsApp отключился ${durationText(forMs)} назад, нужна повторная привязка: ${HINT}`;
}

async function pauseThresholdMs(): Promise<number> {
  const raw = Number((await getSetting("whatsappPauseAlertHours"))?.trim());
  const hours = Number.isFinite(raw) && raw > 0 ? raw : WHATSAPP_PAUSE_ALERT_HOURS_DEFAULT;
  return hours * 3_600_000;
}

/** Строка для панели: только когда плохо уже дольше порога (пауза — дольше `whatsappPauseAlertHours`). */
export function whatsappProblem(now = Date.now()): string | null {
  if (!problem) return null;
  const forMs = now - problem.since;
  const threshold = problem.kind === "paused" ? pauseMs : WHATSAPP_SUSTAINED_MS;
  return forMs >= threshold ? textFor(problem.kind, forMs) : null;
}

export function resetWhatsappWatch(): void {
  problem = null;
  pauseMs = WHATSAPP_PAUSE_ALERT_HOURS_DEFAULT * 3_600_000;
}

function parseSince(raw: string | null): { kind: Kind; since: number } | null {
  const m = /^(down|unlinked|paused):(\d+)$/.exec(raw?.trim() ?? "");
  return m ? { kind: m[1] as Kind, since: Number(m[2]) } : null;
}

async function clearTrouble(): Promise<void> {
  problem = null;
  if (await getSetting(SINCE_KEY)) await setSetting(SINCE_KEY, "");
  if (await getSetting(ALERT_AT_KEY)) await setSetting(ALERT_AT_KEY, "");
}

export async function checkWhatsappConnection(now = Date.now()): Promise<void> {
  if (!whatsappConfigured()) {
    problem = null;
    return;
  }
  let status: BridgeStatus | null = null;
  try {
    status = await bridgeRequest<BridgeStatus>("/status");
  } catch {
    status = null;
  }

  const contactsOk = !!status && status.contactsReady !== false;
  if (status?.state === "ready" && contactsOk) {
    await clearTrouble();
    if (!(await getSetting(EVER_READY_KEY))) await setSetting(EVER_READY_KEY, "1");
    return;
  }
  if (!(await getSetting(EVER_READY_KEY))) {
    problem = null; // ещё ни разу не подключали — отключаться нечему
    return;
  }
  const kind: Kind = status?.state === "paused" && contactsOk ? "paused" : status ? "unlinked" : "down";

  // Начало беды: в памяти → из настроек (переживает перезапуск api) → сейчас.
  // Смена вида беды (обрыв ↔ пауза) счётчик не обнуляет: клиенты всё это время без ответов.
  const saved = parseSince(await getSetting(SINCE_KEY));
  const since = problem?.since ?? saved?.since ?? now;
  if (!problem || problem.kind !== kind || saved?.kind !== kind) {
    problem = { since, kind };
    await setSetting(SINCE_KEY, `${kind}:${since}`);
  }
  pauseMs = await pauseThresholdMs();

  const alertAfter = kind === "paused" ? pauseMs : WHATSAPP_DOWN_ALERT_MS;
  const forMs = now - since;
  if (forMs < alertAfter) return;
  const lastAlert = Number(await getSetting(ALERT_AT_KEY));
  if (Number.isFinite(lastAlert) && lastAlert >= since && now - lastAlert < WHATSAPP_ALERT_REPEAT_MS) return;
  await setSetting(ALERT_AT_KEY, String(now));
  logWarn("whatsappWatch", `${kind} ${durationText(forMs)}`);
  await sendKind("failure", `🟠 ${textFor(kind, forMs)}`);
}
