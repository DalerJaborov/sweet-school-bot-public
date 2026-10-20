/**
 * Общее форматирование для списков.
 *
 * Обе функции существуют ради одной вещи — читаемости на телефоне. Голый
 * идентификатор Instagram («1838771154305671») занимает пол-строки и ничего не
 * говорит, а полная дата («21.08.2026, 22:54:49») отнимает столько же места,
 * хотя на практике важно лишь «давно или только что».
 */

/** Ник, если он есть; иначе короткий хвост идентификатора. */
export function shortWho(username: string | null | undefined, id: string): string {
  if (username) return `@${username}`;
  return id.length > 8 ? `ID ···${id.slice(-6)}` : `ID ${id}`;
}

/** «только что», «12 мин», «3 ч», «вчера», дальше — дата. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const min = Math.round((Date.now() - then) / 60_000);

  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
  const days = Math.round(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  return new Date(then).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Сумма в сомони: тысячи через тонкий пробел, «с.» после числа — «1 640 с.».
 *  Одна функция на все экраны, чтобы плитка на главной и строка в «Деньгах»
 *  не расходились в написании. */
export function money(n: number): string {
  return `${formatNumber(n)} с.`;
}

/** Число с тонким пробелом между тысячами (U+2009), без единицы. */
export function formatNumber(n: number): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(Math.round(n));
  return sign + String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Русская плюрализация. Экспортируется, чтобы DashboardPage/ClientsPage
 *  не дублировали одну и ту же логику в трёх местах. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
