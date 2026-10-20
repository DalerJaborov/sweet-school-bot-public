/**
 * ШАГ 2 МИГРАЦИИ ПЛАТФОРМЫ КУРСОВ — заполнить каталог и связать старые покупки.
 *
 * Запуск на проде:
 *   docker compose exec api npx tsx scripts/backfill-courses.ts
 *
 * Безопасен: идемпотентен (повторный запуск ничего не делает второй раз),
 * ничего не удаляет, обратим одним `UPDATE Purchase SET courseId = NULL`.
 *
 * Останавливается с кодом 1, если в покупках нашёлся код курса, которого нет в
 * каталоге — такую продажу нельзя пропустить молча, её надо разобрать руками.
 * Сама по себе остановка ничего не ломает: связанные покупки уже сохранены,
 * скрипт можно дозапустить после правки каталога.
 */
import { prisma, logError, logInfo } from "../src/db.js";
import { backfillCourses, logBackfill } from "../src/services/courseCatalog.js";

async function main(): Promise<void> {
  const result = await backfillCourses();
  logBackfill(result);

  const left = await prisma.purchase.count({ where: { courseId: null } });
  if (result.unknownCourses.length > 0) {
    logError(
      "backfill:courses",
      new Error(
        `Не связано покупок: ${left}. Неизвестные коды курсов: ${result.unknownCourses.join(", ")}. ` +
          `Добавьте курс в каталог и запустите скрипт снова.`
      )
    );
    process.exitCode = 1;
    return;
  }

  logInfo("backfill:courses", `готово, покупок без курса осталось ${left} (ожидается 0)`);
  if (left !== 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logError("backfill:courses", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
