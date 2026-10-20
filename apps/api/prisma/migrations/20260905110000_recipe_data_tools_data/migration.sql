-- Структурированный рецепт (карточка рецепта v2, scratchpad/visual-ideas.md
-- §2) и набор инструментов курса (§5). Аддитивно: Lesson.recipeData —
-- необязательная колонка (null у уроков без распознавания карточки),
-- Course.toolsData — с безопасным дефолтом "[]", старые строки не трогаем.
ALTER TABLE "Lesson" ADD COLUMN "recipeData" TEXT;
ALTER TABLE "Course" ADD COLUMN "toolsData" TEXT NOT NULL DEFAULT '[]';
