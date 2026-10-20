/**
 * Безопасный разбор JSON-колонок.
 *
 * В базе несколько текстовых полей хранят JSON (Contact.tags, Funnel.keywords,
 * Funnel.mediaIds, FunnelStep.buttons). Голый JSON.parse на битой строке —
 * старый ручной импорт, миграция, правка в SQLite напрямую — бросает
 * исключение, и весь список (/admin/funnels, /admin/contacts) отдаёт 500 из-за
 * одной записи. Здесь один хелпер на все места: битое значение превращается в
 * пустой массив, а не в упавший экран панели.
 */

/** JSON-массив или [] — при любом мусоре. `guard` отсекает элементы не той формы. */
export function parseJsonArray<T>(raw: string | null | undefined, guard: (item: unknown) => item is T): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

export function isNonEmptyString(item: unknown): item is string {
  return typeof item === "string" && item.trim().length > 0;
}

/** Массив непустых строк — теги, ключевые слова, идентификаторы публикаций. */
export function parseStringArray(raw: string | null | undefined): string[] {
  return parseJsonArray(raw, isNonEmptyString);
}

/** Кнопка шага воронки в базе: надпись + НОМЕР шага (order), на который ведёт.
 *  Номер, а не id — чтобы редактор мог пересохранять шаги целиком. */
export type StepButton = { title: string; targetOrder: number };

export function isStepButton(item: unknown): item is StepButton {
  if (typeof item !== "object" || item === null) return false;
  const b = item as Record<string, unknown>;
  return isNonEmptyString(b.title) && Number.isInteger(b.targetOrder);
}

export function parseStepButtonsJson(raw: string | null | undefined): StepButton[] {
  return parseJsonArray(raw, isStepButton);
}

/** Инструмент курса (Course.toolsData, визуальная система 04.09.2026, §5):
 *  насадка, форма и т.п. — название, фото (если владелец загрузил), номер
 *  насадки на фото и ссылка «где купить». Все три необязательны — карточка
 *  инструмента рисуется и без них, просто с плейсхолдером/без ссылки. */
export type CourseTool = { name: string; photoUrl: string | null; toolNumber: string | null; buyLink: string | null };

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export function isCourseTool(item: unknown): item is CourseTool {
  if (typeof item !== "object" || item === null) return false;
  const t = item as Record<string, unknown>;
  return isNonEmptyString(t.name) && isNullableString(t.photoUrl) && isNullableString(t.toolNumber) && isNullableString(t.buyLink);
}

export function parseCourseTools(raw: string | null | undefined): CourseTool[] {
  return parseJsonArray(raw, isCourseTool);
}
