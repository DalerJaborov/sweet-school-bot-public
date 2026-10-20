/**
 * БЭКФИЛЛ РАСШИФРОВОК УРОКОВ — код есть с самого начала (course/transcribe.ts,
 * подключён в videoPipeline.ts на каждый новый урок), но настройка
 * `lessonTranscribeEnabled` стояла "false" — обещание владельцу так и не
 * выполнилось: все 31 уже загруженных урока помечены transcriptStatus=SKIPPED,
 * и помощница в чате ученицы отвечает только по рецепту, без того, что Ширин
 * реально говорит в видео (05.09.2026 — владелец вспомнил и спросил статус).
 *
 * Этот скрипт разбирает АУДИО каждого READY-урока, у которого ещё нет
 * transcript: скачивает исходник из R2 (sourcePath жив у всех 31 на 06.09.2026),
 * вынимает голую дорожку ffmpeg (extractAudio — тот же приём, что в основном
 * пайплайне), отдаёт Gemini на распознавание (transcribeLesson). Стоимость на
 * 6 часов видео — единицы центов, разово (см. комментарий в transcribe.ts).
 *
 * Перед запуском включить настройку в БД (или через панель, когда там появится
 * переключатель):
 *   UPDATE Setting SET value='true' WHERE key='lessonTranscribeEnabled';
 * (или просто polностью убрать строку — код по умолчанию расшифровывает).
 *
 * Запуск на проде:
 *   docker compose exec api npx tsx scripts/backfill-transcribe.ts
 *
 * Безопасен и идемпотентен: берёт только READY-уроки с transcript = null,
 * повторный запуск не трогает уже расшифрованные. Ошибка одного урока не
 * останавливает остальные.
 */
// Импорт из dist/, а не src/ — тот же приём, что у backfill-covers.ts: скрипт
// выполняется в боевом образе, где скомпилирован только dist/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma, logError, logInfo } from "../dist/db.js";
import { storageConfig, getObjectToFile } from "../dist/storage/s3.js";
import { extractAudio, transcribeLesson } from "../dist/course/transcribe.js";

async function main(): Promise<void> {
  const cfg = await storageConfig();
  if (!cfg) {
    logError("backfill:transcribe", new Error("Хранилище не настроено — заполните ключи R2 в настройках панели"));
    process.exitCode = 1;
    return;
  }

  const lessons = await prisma.lesson.findMany({
    where: { status: "READY", transcript: null, deletedAt: null, sourcePath: { not: null } },
    select: { id: true, title: true, sourcePath: true },
    orderBy: { order: "asc" },
  });

  logInfo("backfill:transcribe", `к обработке: ${lessons.length} урок(ов)`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const lesson of lessons) {
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "transcribe-"));
    try {
      const sourceFile = path.join(work, "source" + path.extname(lesson.sourcePath as string));
      const downloaded = await getObjectToFile(cfg, lesson.sourcePath as string, sourceFile);
      if (!downloaded) {
        logError("backfill:transcribe", new Error(`урок ${lesson.id} (${lesson.title}): исходник не найден в хранилище`));
        failed += 1;
        continue;
      }

      const audio = await extractAudio(sourceFile, work);
      if (!audio) {
        logInfo("backfill:transcribe", `урок ${lesson.id} (${lesson.title}): звук не вынулся, пропущен`);
        skipped += 1;
        continue;
      }

      const ok = await transcribeLesson(lesson.id, audio);
      if (ok) {
        logInfo("backfill:transcribe", `урок ${lesson.id} (${lesson.title}): расшифрован`);
        done += 1;
      } else {
        logInfo("backfill:transcribe", `урок ${lesson.id} (${lesson.title}): без речи или отключено — пропущен`);
        skipped += 1;
      }
    } catch (err) {
      logError("backfill:transcribe", err);
      failed += 1;
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  logInfo("backfill:transcribe", `итого: расшифровано ${done}, пропущено ${skipped}, ошибок ${failed} из ${lessons.length}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logError("backfill:transcribe", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
