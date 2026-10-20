/**
 * БЭКФИЛЛ ОБЛОЖЕК — сгенерировать cover.jpg/story.jpg для уроков, готовых до
 * того, как появилась генерация обложек (storage/coverArt.ts, videoPipeline.ts).
 * На момент написания это 21 урок COURSE70 и 10 уроков COURSE50 из недавнего
 * импорта — у них есть posterPath, но нет coverPath/storyPath.
 *
 * Источник кадра — тот же приоритет, что и при обычном транскоде: если есть
 * тизер, лучше было бы взять кадр С НЕГО (готовый десерт), но перекодировать
 * тизер заново здесь не нужно — teaser.mp4 в бакете УЖЕ содержит нужный кадр
 * не отдельным файлом, а как последний кадр видео. Гонять ffmpeg по видео из
 * бакета ради одного кадра — overkill для разового скрипта: посты уроков и так
 * обновлялись через obычный поток (processTeaser), у READY-уроков с тизером
 * cover/story уже стоят, если тизер обработан ПОСЛЕ этого релиза. Поэтому
 * бэкфилл берёт кадр из уже существующего posterPath — он есть у каждого
 * READY-урока (обычный постер урока ИЛИ, если тизер обрабатывался раньше,
 * последний кадр тизера — posterPath общий, см. processTeaser). Урок без
 * posterPath пропускается — рендерить обложку не из чего.
 *
 * Запуск на проде (после деплоя миграции 20260905100000_lesson_covers):
 *   docker compose exec api npx tsx scripts/backfill-covers.ts
 *
 * Безопасен и идемпотентен: берёт только READY-уроки с coverPath = null,
 * повторный запуск не трогает уже обработанные. Ничего не удаляет. Ошибка
 * рендера одного урока не останавливает остальные — обложка вторична, как и
 * в основном пайплайне.
 *
 * НЕ ЗАПУСКАТЬ АВТОМАТИЧЕСКИ — только руками после деплоя, см. отчёт.
 */
// Импорт из dist/, а не src/: скрипт запускается в боевом образе
// (`docker compose exec api npx tsx scripts/backfill-covers.ts`), а тот
// копирует только скомпилированный dist/ — исходников src/ там нет
// (см. Dockerfile). tsc эту папку не проверяет (tsconfig include: ["src"]).
import { prisma, logError, logInfo } from "../dist/db.js";
import { storageConfig, getObject } from "../dist/storage/s3.js";
import { generateLessonCovers } from "../dist/storage/videoPipeline.js";

async function main(): Promise<void> {
  const cfg = await storageConfig();
  if (!cfg) {
    logError("backfill:covers", new Error("Хранилище не настроено — заполните ключи R2 в настройках панели"));
    process.exitCode = 1;
    return;
  }

  const lessons = await prisma.lesson.findMany({
    where: { status: "READY", coverPath: null },
    select: { id: true, moduleId: true, order: true, title: true, durationSec: true, posterPath: true },
    orderBy: { order: "asc" },
  });

  logInfo("backfill:covers", `к обработке: ${lessons.length} урок(ов)`);

  let done = 0;
  let skippedNoPoster = 0;
  let failed = 0;

  for (const lesson of lessons) {
    if (!lesson.posterPath) {
      logInfo("backfill:covers", `урок ${lesson.id}: нет posterPath, пропущен (рендерить не из чего)`);
      skippedNoPoster += 1;
      continue;
    }

    try {
      const frame = await getObject(cfg, lesson.posterPath);
      if (!frame) {
        logError("backfill:covers", new Error(`урок ${lesson.id}: постер ${lesson.posterPath} не найден в хранилище`));
        failed += 1;
        continue;
      }

      const prefix = `courses/${lesson.moduleId}/${lesson.id}`;
      const { coverPath, storyPath } = await generateLessonCovers(cfg, prefix, frame, {
        number: lesson.order,
        title: lesson.title,
        durationMin: Math.round((lesson.durationSec ?? 0) / 60),
      });

      if (!coverPath && !storyPath) {
        logError("backfill:covers", new Error(`урок ${lesson.id}: обе обложки не отрендерились`));
        failed += 1;
        continue;
      }

      await prisma.lesson.update({
        where: { id: lesson.id },
        data: { ...(coverPath ? { coverPath } : {}), ...(storyPath ? { storyPath } : {}) },
      });
      logInfo("backfill:covers", `урок ${lesson.id}: готово (${coverPath ? "cover" : "—"}, ${storyPath ? "story" : "—"})`);
      done += 1;
    } catch (err) {
      logError("backfill:covers", err);
      failed += 1;
    }
  }

  logInfo("backfill:covers", `итого: готово ${done}, без постера ${skippedNoPoster}, ошибок ${failed} из ${lessons.length}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logError("backfill:covers", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
