import { createHash } from "node:crypto";
import { getSetting, setSetting } from "./db.js";

/**
 * ШЛЮЗ ДЛЯ ТЕХНИЧЕСКИХ ТРЕВОГ (08.11.2026): тишина по умолчанию.
 *
 * • cooldown — один и тот же алерт (по ключу) не чаще, чем раз в `cooldownMs`
 *   (по умолчанию 6 часов);
 * • sustained — сбой должен длиться непрерывно не меньше `sustainedMs`
 *   (30 минут): перезапуск моста WhatsApp или секундный обрыв сети никого не
 *   будят. «Непрерывно» = сбой повторялся с паузами не больше `gapMs`; если
 *   пауза длиннее, сбой считается закончившимся и отсчёт начинается заново.
 *
 * Состояние — в базе (настройка), а не в памяти: контейнер перезапускается при
 * каждой выкатке.
 */
export const ALERT_COOLDOWN_MS = 6 * 3_600_000;
export const ALERT_SUSTAINED_MS = 30 * 60_000;
const ALERT_GAP_MS = 45 * 60_000;

type GateState = { first: number; last: number; sent: number | null };

function stateKey(key: string): string {
  return `alertGate:${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

export async function shouldSendAlert(
  key: string,
  opts: { sustainedMs?: number; cooldownMs?: number; now?: number } = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const sustainedMs = opts.sustainedMs ?? 0;
  const cooldownMs = opts.cooldownMs ?? ALERT_COOLDOWN_MS;
  const k = stateKey(key);

  let st: GateState | null = null;
  try {
    const raw = await getSetting(k);
    st = raw ? (JSON.parse(raw) as GateState) : null;
  } catch {
    st = null;
  }

  if (!st || now - st.last > ALERT_GAP_MS) st = { first: now, last: now, sent: st?.sent ?? null };
  else st.last = now;

  let send = true;
  if (sustainedMs > 0 && now - st.first < sustainedMs) send = false;
  if (send && st.sent !== null && now - st.sent < cooldownMs) send = false;
  if (send) st.sent = now;

  await setSetting(k, JSON.stringify(st));
  return send;
}
