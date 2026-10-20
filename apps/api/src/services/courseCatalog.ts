import { prisma, logInfo } from "../db.js";
import { COURSE_50, COURSE_70, COURSE_TITLE, PRICE, type Course as CourseCode } from "../courses.js";
import type { Course } from "@prisma/client";

/**
 * КАТАЛОГ КУРСОВ — мост между старыми константами и таблицей Course.
 *
 * До платформы курсы жили двумя константами в courses.ts: добавить третий было
 * нельзя без правки кода и деплоя. Теперь они строки в базе, но переключение
 * идёт в два приёма (см. docs/course-platform-design.md §3): сначала таблица
 * заполняется из констант и код читает её, а сами константы остаются как
 * источник цен и названий по умолчанию. Удаляются они отдельным релизом, когда
 * весь код гарантированно ходит по courseId.
 *
 * Здесь же живёт backfill: он идемпотентный и вызывается и скриптом, и тестами.
 */

/** Начальный каталог из констант — ровно то, что школа продаёт сегодня. */
export const SEED_COURSES: { code: CourseCode; title: string; price: number; order: number }[] = [
  { code: COURSE_50, title: COURSE_TITLE[COURSE_50], price: PRICE[COURSE_50], order: 1 },
  { code: COURSE_70, title: COURSE_TITLE[COURSE_70], price: PRICE[COURSE_70], order: 2 },
];

export type BackfillResult = {
  coursesCreated: number;
  coursesExisting: number;
  purchasesLinked: number;
  /** Покупки, для которых курса в каталоге не нашлось — их коды. */
  unknownCourses: string[];
};

/**
 * Заполняет каталог и связывает старые покупки с курсами.
 *
 * ИДЕМПОТЕНТЕН: повторный запуск ничего не портит и ничего не делает второй
 * раз — курсы через upsert, покупки только там, где courseId ещё пуст. Это
 * важно: скрипт запускается руками на проде, и «а я уже запускал?» не должно
 * быть страшным вопросом.
 *
 * НЕ МОЛЧИТ О НЕИЗВЕСТНОМ: если в Purchase.course окажется код, которого нет в
 * каталоге (ручная правка базы, будущий третий курс), такие покупки НЕ
 * связываются, а их коды возвращаются вызывающему. Скрипт на этом
 * останавливается с ненулевым кодом выхода — молча пропустить продажу нельзя.
 */
export async function backfillCourses(): Promise<BackfillResult> {
  let coursesCreated = 0;
  let coursesExisting = 0;

  for (const seed of SEED_COURSES) {
    const existing = await prisma.course.findUnique({ where: { code: seed.code } });
    if (existing) {
      coursesExisting += 1;
      continue;
    }
    await prisma.course.create({
      data: { code: seed.code, title: seed.title, price: seed.price, order: seed.order },
    });
    coursesCreated += 1;
  }

  const catalog = await prisma.course.findMany();
  const byCode = new Map<string, Course>(catalog.map((c) => [c.code, c]));

  // Только непривязанные: повторный запуск не трогает уже связанные покупки.
  const orphans = await prisma.purchase.findMany({
    where: { courseId: null },
    select: { id: true, course: true },
  });

  let purchasesLinked = 0;
  const unknown = new Set<string>();
  for (const purchase of orphans) {
    const course = byCode.get(purchase.course);
    if (!course) {
      unknown.add(purchase.course);
      continue;
    }
    await prisma.purchase.update({ where: { id: purchase.id }, data: { courseId: course.id } });
    purchasesLinked += 1;
  }

  return {
    coursesCreated,
    coursesExisting,
    purchasesLinked,
    unknownCourses: [...unknown],
  };
}

/** Курс по коду. Пока каталог не заполнен, возвращает null — вызывающий код
 *  обязан уметь работать по старой строке Purchase.course. */
export async function courseByCode(code: string): Promise<Course | null> {
  return prisma.course.findUnique({ where: { code } });
}

/** Активные курсы для витрины и панели, в порядке показа. */
export async function activeCourses(): Promise<Course[]> {
  return prisma.course.findMany({ where: { active: true }, orderBy: { order: "asc" } });
}

/** Печать итога backfill в единый лог — общая для скрипта и тестов. */
export function logBackfill(result: BackfillResult): void {
  logInfo(
    "backfill:courses",
    `курсов создано ${result.coursesCreated}, уже было ${result.coursesExisting}, ` +
      `покупок связано ${result.purchasesLinked}` +
      (result.unknownCourses.length > 0 ? `, НЕИЗВЕСТНЫХ кодов ${result.unknownCourses.join(", ")}` : "")
  );
}
