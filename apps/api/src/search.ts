import { Router } from "express";
import { prisma } from "./db.js";
import { autoCatch } from "./asyncRoute.js";

/**
 * ⌘K / ПОИСК СВЕРХУ («Утро Ширин» §18, волна 3A).
 *
 * Одна строка на ПК и в шапке телефона: «мадина» → ученица, «цена» →
 * раздел «Тексты и цены», «чек» → очередь чеков, «тирамису» → урок. Ответ
 * сгруппирован (ученицы · уроки · разделы), в каждой группе не больше
 * восьми строк — палитра, а не отчёт. Разделы ищутся без базы, по
 * статическому списку с синонимами: владелица думает словами «реквизиты»,
 * «цена», а не названиями вкладок.
 *
 * SQLite сравнивает LIKE без учёта регистра только для ASCII, поэтому для
 * кириллицы («Мадина» / «мадина») запрос идёт тремя вариантами написания.
 */
export const searchRouter = autoCatch(Router());

export const MIN_QUERY = 2;
export const GROUP_LIMIT = 8;

export type SectionHit = { tab: string; title: string };
export type StudentHit = { id: string; handle: string; name: string | null; paid: boolean; phone: string | null };
export type LessonHit = { id: string; title: string; order: number; course: string };
export type SearchResponse = { q: string; students: StudentHit[]; lessons: LessonHit[]; sections: SectionHit[] };

/** Разделы панели и слова, которыми их называют вслух. Порядок — по частоте. */
export const SECTIONS: { tab: string; title: string; words: string[] }[] = [
  { tab: "home", title: "Сегодня", words: ["главная", "утро", "сводка", "очередь"] },
  { tab: "receipts", title: "Чеки", words: ["чек", "оплата", "подтвердить", "квитанция"] },
  { tab: "questions", title: "Вопросы", words: ["вопрос", "ответить", "чат", "ученица спрашивает"] },
  { tab: "money", title: "Деньги", words: ["выручка", "продажи", "доход", "сомони", "воронка продаж"] },
  { tab: "clients", title: "Ученицы", words: ["ученица", "клиент", "контакт", "доступ", "ссылка"] },
  { tab: "courses", title: "Курсы", words: ["курс", "урок", "видео", "рецепт"] },
  { tab: "import", title: "Импорт", words: ["импорт", "загрузить уроки", "telegram", "папка"] },
  { tab: "texts", title: "Тексты и цены", words: ["цена", "цены", "реквизиты", "стоимость", "текст", "приветствие", "сертификат", "офлайн"] },
  { tab: "settings", title: "Настройки", words: ["настройка", "ключ", "gemini", "instagram", "бот", "лимит"] },
];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е");
}

/** Раздел подходит, если запрос — начало его названия или любого синонима
 *  («цен» → «цена» → Тексты и цены), либо название содержит запрос целиком. */
export function searchSections(query: string): SectionHit[] {
  const q = norm(query);
  if (q.length < MIN_QUERY) return [];
  return SECTIONS.filter((s) => {
    const title = norm(s.title);
    if (title.includes(q)) return true;
    return s.words.some((w) => {
      const word = norm(w);
      return word.startsWith(q) || q.startsWith(word) || word.split(" ").some((part) => part.startsWith(q));
    });
  })
    .slice(0, GROUP_LIMIT)
    .map(({ tab, title }) => ({ tab, title }));
}

/** Варианты написания для регистронезависимого LIKE по кириллице. */
function spellings(q: string): string[] {
  const lower = q.toLowerCase();
  const capital = lower.charAt(0).toUpperCase() + lower.slice(1);
  return Array.from(new Set([q, lower, capital]));
}

type ContactRow = {
  id: string;
  username: string | null;
  name: string | null;
  igUserId: string;
  paid: boolean;
  offlineSignup: { name: string; phone: string } | null;
};

export async function searchStudents(q: string): Promise<StudentHit[]> {
  const variants = spellings(q);
  const rows = (await prisma.contact.findMany({
    where: {
      OR: variants.flatMap((v) => [
        { username: { contains: v } },
        { name: { contains: v } },
        { offlineSignup: { is: { name: { contains: v } } } },
        { offlineSignup: { is: { phone: { contains: v } } } },
      ]),
    },
    select: { id: true, username: true, name: true, igUserId: true, paid: true, offlineSignup: { select: { name: true, phone: true } } },
    orderBy: [{ paid: "desc" }, { updatedAt: "desc" }],
    take: GROUP_LIMIT * 2,
  })) as ContactRow[];
  // Оплатившие — первыми и в JS тоже: порядок не должен зависеть от того,
  // как драйвер сортирует булево поле.
  return rows
    .sort((a, b) => Number(b.paid) - Number(a.paid))
    .slice(0, GROUP_LIMIT)
    .map((c) => ({
      id: c.id,
      handle: c.username ? `@${c.username}` : c.name ?? c.igUserId,
      name: c.offlineSignup?.name ?? c.name ?? null,
      paid: c.paid,
      phone: c.offlineSignup?.phone ?? null,
    }));
}

type LessonRow = { id: string; title: string; order: number; module: { course: { title: string } } };

export async function searchLessons(q: string): Promise<LessonHit[]> {
  const rows = (await prisma.lesson.findMany({
    // Корзина («Утро Ширин» §19): удалённый урок не должен находиться по ⌘K —
    // клик по нему открыл бы «Курсы», где его нет.
    where: { deletedAt: null, OR: spellings(q).map((v) => ({ title: { contains: v } })) },
    select: { id: true, title: true, order: true, module: { select: { course: { select: { title: true } } } } },
    orderBy: { order: "asc" },
    take: GROUP_LIMIT,
  })) as LessonRow[];
  return rows.map((l) => ({ id: l.id, title: l.title, order: l.order, course: l.module.course.title }));
}

searchRouter.get("/admin/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  if (q.length < MIN_QUERY) {
    res.json({ q, students: [], lessons: [], sections: [] } satisfies SearchResponse);
    return;
  }
  const [students, lessons] = await Promise.all([searchStudents(q), searchLessons(q)]);
  res.json({ q, students, lessons, sections: searchSections(q) } satisfies SearchResponse);
});
