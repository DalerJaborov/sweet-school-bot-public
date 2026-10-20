/**
 * НАСТРОЙКИ ПЛЕЕРА В localStorage. Скорость — потому что кто привык слушать
 * на 1.5×, хочет так каждый урок, а не выбирать заново; подсказка о жестах —
 * потому что показывать её нужно ровно один раз. Ручное качество сюда
 * намеренно НЕ пишем: связь в дороге и дома разная, и «480p навсегда» из-за
 * одной поездки в маршрутке было бы медвежьей услугой — оно живёт в памяти
 * только до закрытия страницы.
 *
 * localStorage может быть недоступен (приватный режим Safari, запрет данных
 * сайта) — каждое обращение обёрнуто, без него плеер просто работает как в
 * первый раз.
 */
export const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
export type Rate = (typeof RATES)[number];

const RATE_KEY = "ssb_rate";
const HINT_KEY = "ssb_player_hint";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Нет хранилища — нет памяти между открытиями, ничего страшного.
  }
}

export function isRate(n: number): n is Rate {
  return (RATES as readonly number[]).includes(n);
}

export function loadRate(): Rate {
  const n = Number(read(RATE_KEY));
  return isRate(n) ? n : 1;
}

export function saveRate(rate: Rate): void {
  write(RATE_KEY, String(rate));
}

export function hintSeen(): boolean {
  return read(HINT_KEY) === "1";
}

export function markHintSeen(): void {
  write(HINT_KEY, "1");
}
