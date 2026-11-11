/**
 * ФАКТЫ ОФЛАЙН-КУРСА — значения по умолчанию. Настоящие читаются из Settings
 * через services/salesTextsService.getOfflineFacts(); владелец правит их в
 * разделе панели «Цены и даты» (единственный писатель — services/offerService.ts).
 * Файл без зависимостей — его импортируют и карточка бота (offlineCourse.ts),
 * и сервис настроек, и тесты.
 *
 * 08.11.2026: часы и адрес по умолчанию сведены к сайту. Сайт ещё 24.10.2026
 * переехал на «Водонасос, дом Додо Пицца» и 13:40–16:30 (коммит cc0b3e2, тест
 * сайта запрещает «14:00|17:00|Рудаки»), напоминание накануне курса тоже звало
 * к 13:40 на Водонасос, а карточка бота продолжала говорить «Рудаки 156а, с
 * 14:00 до 17:00». Время 13:40–16:30 подтвердил владелец.
 */
export type OfflineFacts = {
  /** Стоимость в сомони. */
  price: number;
  /** Длительность в днях. */
  days: number;
  /** Часы занятий: «13:40–16:30» (так пишет панель). Старые значения вида
   *  «14:00 до 17:00» тоже понимаются — см. parseHours. */
  hours: string;
  /** Сколько видов десертов готовят. */
  desserts: number;
  address: string;
  /** Мест в группе; null — не говорить клиентам число (владелец не задал). */
  seats: number | null;
};

// Адрес — Рудаки 177, назди Воданасос (владелец 08.11.2026, повторно 11.11.2026:
// «везде Душанбе, Рудаки 177, назди Воданасос»). «Рудаки 156, доми Додо Пицца» из
// старого промпта и шага воронки отменён. Настоящий адрес задаёт настройка
// offlineCourseAddress. Таджикский — как пишет сам владелец, без особых букв.
export const DEFAULT_OFFLINE_ADDRESS_TG = "Душанбе, Рудаки 177, назди Воданасос";

/** 22 вида — владелец 11.11.2026, по картинке «МЕНЮ КУРСА», которую шлёт сама Ширин. */
export const OFFLINE_DESSERTS_DEFAULT = 22;

export const DEFAULT_OFFLINE_FACTS: OfflineFacts = {
  price: 700,
  days: 8,
  hours: "13:40–16:30",
  // ОДНО МЕСТО ДЛЯ ЧИСЛА ДЕСЕРТОВ (11.11.2026). В переписках звучало 20, 21 и 22:
  // шаблон воронки — 20, карточка бота — 21, Ширин — 22. Владелец подтвердил 22.
  // Шаг воронки берёт число подстановкой {десерты} (funnelPlaceholders.ts),
  // настройка offlineCourseDesserts в «Цены и даты» перекрывает это значение.
  desserts: OFFLINE_DESSERTS_DEFAULT,
  address: "Душанбе, Рудаки 177, ориентир Воданасос",
  seats: null,
};

/** ЧЧ:ММ, 00:00–23:59. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type HoursRange = { from: string; to: string };

/** «13:40–16:30», «13:40 - 16:30», «14:00 до 17:00», «9:00 то 12:00» → {from, to}; иначе null. */
export function parseHours(raw: string): HoursRange | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(?:–|—|-|до|то)\s*(\d{1,2}):(\d{2})\s*$/u.exec(raw ?? "");
  if (!m) return null;
  const from = `${m[1].padStart(2, "0")}:${m[2]}`;
  const to = `${m[3].padStart(2, "0")}:${m[4]}`;
  return HHMM.test(from) && HHMM.test(to) ? { from, to } : null;
}

/** Каноническая запись часов для Settings: «13:40–16:30». */
export function hoursValue(range: HoursRange): string {
  return `${range.from}–${range.to}`;
}

/** Часы словами: «с 13:40 до 16:30» / «аз 13:40 то 16:30». Нераспознанный
 *  старый текст отдаётся как есть — лучше слова владельца, чем пустота. */
export function formatHours(hours: string, language: "ru" | "tg"): string {
  const range = parseHours(hours);
  if (!range) return hours;
  return language === "tg" ? `аз ${range.from} то ${range.to}` : `с ${range.from} до ${range.to}`;
}

/** Русское число с существительным: 1 день, 2 дня, 5 дней, 21 день. По-таджикски
 *  существительное после числа не меняется («21 ширинӣ», «8 рӯз»). */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «8 дней», «21 десерт» — для текстов сайта и карточки, где число меняется в панели. */
export const daysWordRu = (n: number): string => `${n} ${pluralRu(n, "день", "дня", "дней")}`;
export const dessertsWordRu = (n: number): string => `${n} ${pluralRu(n, "десерт", "десерта", "десертов")}`;

/** Адрес без города — для разметки поисковиков (город там отдельным полем). */
export function streetAddress(address: string): string {
  return address.replace(/^\s*Душанбе\s*,\s*/u, "").trim() || address;
}

/** Адрес для таджикской версии: по умолчанию — переведённый, свой — как есть. */
export function offlineAddress(facts: OfflineFacts, language: "ru" | "tg"): string {
  return language === "tg" && facts.address === DEFAULT_OFFLINE_FACTS.address
    ? DEFAULT_OFFLINE_ADDRESS_TG
    : facts.address;
}
