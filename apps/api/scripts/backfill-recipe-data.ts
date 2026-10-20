/**
 * БЭКФИЛЛ СТРУКТУРИРОВАННЫХ РЕЦЕПТОВ — recipeData для уроков, распознанных
 * ДО того, как появилась структурированная копия (recipeData, карточка
 * рецепта v2 с чекбоксами). На момент написания это 31 урок (21 «21 рецепт»
 * + 10 «Арт-десерты»): у них уже есть recipeText (markdown) и recipeSource
 * "card-ocr", но recipeData пуст — карточка v2 у них падает в честный отказ
 * (plain-text), пока не распознать карточки заново.
 *
 * Источник — те же фото карточек, что и при импорте (recipePhotos), их
 * распознавание НЕ нужно повторять руками: тот же ocrRecipeCard, что и в
 * importRoutes.ts, тот же mergeRecipeCards. Один платный вызов Gemini на
 * карточку, максимум MAX_OCR_CARDS штук на урок — те же деньги, что уже были
 * потрачены при самом импорте, просто распознаём второй раз для JSON вместо
 * текста (первый раз просили только markdown).
 *
 * Импорт из dist/, а не src/: скрипт запускается в боевом образе, где
 * исходников src/ нет (см. backfill-covers.ts, тот же урок 04.09.2026).
 *
 * Запуск на проде (после деплоя миграции 20260905110000_recipe_data_tools_data):
 *   docker compose exec api npx tsx scripts/backfill-recipe-data.ts
 *
 * НЕ ЗАПУСКАТЬ АВТОМАТИЧЕСКИ — только руками после деплоя.
 */
import { prisma, logError, logInfo } from "../dist/db.js";
import { storageConfig, getObject } from "../dist/storage/s3.js";
import { ocrRecipeCard, mergeRecipeCards } from "../dist/course/cardOcr.js";
import { parseStringArray } from "../dist/json.js";

const MAX_OCR_CARDS = 3;

function mimeOf(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}

async function main(): Promise<void> {
  const cfg = await storageConfig();
  if (!cfg) {
    logError("backfill:recipeData", new Error("хранилище не настроено"));
    return;
  }
  const lessons = await prisma.lesson.findMany({
    where: { recipeData: null, recipeText: { not: null }, recipeSource: "card-ocr" },
    select: { id: true, title: true, recipePhotos: true },
  });
  logInfo("backfill:recipeData", `к обработке: ${lessons.length} урок(ов)`);

  let done = 0;
  let noPhotos = 0;
  let errors = 0;
  for (const lesson of lessons) {
    try {
      const photos = parseStringArray(lesson.recipePhotos).slice(0, MAX_OCR_CARDS);
      if (!photos.length) {
        noPhotos++;
        continue;
      }
      const parsedCards = [];
      for (const key of photos) {
        const buf = await getObject(cfg, key);
        if (!buf) continue;
        const card = await ocrRecipeCard(buf, mimeOf(key));
        if (card) parsedCards.push(card);
      }
      const merged = mergeRecipeCards(parsedCards);
      if (!merged) {
        logInfo("backfill:recipeData", `урок ${lesson.id} (${lesson.title}): карточка не распозналась`);
        continue;
      }
      await prisma.lesson.update({ where: { id: lesson.id }, data: { recipeData: JSON.stringify(merged) } });
      done++;
      logInfo("backfill:recipeData", `урок ${lesson.id} (${lesson.title}): готово`);
    } catch (err) {
      errors++;
      logError("backfill:recipeData:lesson", err);
    }
  }
  logInfo("backfill:recipeData", `итого: готово ${done}, без карточек ${noPhotos}, ошибок ${errors} из ${lessons.length}`);
  if (errors > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logError("backfill:recipeData", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
