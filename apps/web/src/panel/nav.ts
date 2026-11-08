/**
 * КАРТА РАЗДЕЛОВ ПАНЕЛИ — одно место, откуда берутся и нижняя панель на
 * телефоне, и сайдбар на ПК, и экран «Ещё».
 *
 * Имена в коде (id) не меняются; здесь только то, что видит человек: простое
 * название и одна строка «что это». Жаргона нет — словарь замен владельца
 * (воронка → автосообщения, лид → заявка, слот → свободное время).
 */
export type Tab =
  | "home"
  | "recipes"
  | "receipts"
  | "questions"
  | "attention"
  | "clients"
  | "more"
  | "summary"
  | "money"
  | "texts"
  | "courses"
  | "funnels"
  | "journal"
  | "style"
  | "media"
  | "import"
  | "quality"
  | "testimonials"
  | "settings";

export type NavGroup = "main" | "expert";

export type SectionInfo = {
  id: Tab;
  label: string;
  /** Одна строка под названием в «Ещё». */
  about: string;
  group: NavGroup;
};

/** Нижняя панель на телефоне. «Ещё» — отдельный экран (MorePage). */
export const BOTTOM_NAV: { id: Tab; label: string }[] = [
  { id: "home", label: "Сегодня" },
  { id: "receipts", label: "Чеки" },
  { id: "clients", label: "Клиенты" },
  { id: "courses", label: "Курсы и цены" },
  { id: "more", label: "Ещё" },
];

/** В режиме сестры — только то, что нужно для разбора заявок и чеков. */
export const SIMPLE_TABS: ReadonlySet<Tab> = new Set<Tab>(["home", "receipts", "questions", "attention", "clients", "more"]);

/** Разделы экрана «Ещё». Нижняя панель их не дублирует. */
export const MORE_SECTIONS: SectionInfo[] = [
  { id: "money", label: "Деньги", about: "Сколько заработано и кто оплатил", group: "main" },
  { id: "summary", label: "Сводка дня", about: "Цифры за вчера и неделю", group: "main" },
  { id: "testimonials", label: "Отзывы", about: "Что говорят ученицы", group: "main" },
  { id: "settings", label: "Настройки", about: "Подключения и работа помощника", group: "main" },
  { id: "funnels", label: "Автосообщения", about: "Цепочки сообщений, которые уходят сами", group: "expert" },
  { id: "journal", label: "История переписки", about: "Кто и как проходит автосообщения", group: "expert" },
  {
    id: "quality",
    label: "Проверка ответов помощника",
    about: "Где помощник ошибся и как вы поправили",
    group: "expert",
  },
  { id: "style", label: "Образцы ответов", about: "Как помощник учится отвечать вашими словами", group: "expert" },
  { id: "media", label: "Фото и видео для ответов", about: "Что помощник может присылать клиентам", group: "expert" },
  { id: "import", label: "Загрузка уроков", about: "Перенос уроков из Telegram", group: "expert" },
];

/** Какие разделы можно открыть, когда включён режим сестры. */
export function isAllowed(tab: Tab, simple: boolean): boolean {
  return !simple || SIMPLE_TABS.has(tab);
}

/** Нижняя панель с учётом режима: у сестры «Курсы и цены» не нужны. */
export function bottomNavFor(simple: boolean): { id: Tab; label: string }[] {
  return BOTTOM_NAV.filter((item) => isAllowed(item.id, simple));
}

/** Разделы, которые подсвечивают одну кнопку внизу. */
export function navOwner(tab: Tab): Tab {
  if (tab === "questions" || tab === "attention") return "receipts";
  if (tab === "texts" || tab === "recipes") return "courses";
  if (MORE_SECTIONS.some((s) => s.id === tab)) return "more";
  return tab;
}
