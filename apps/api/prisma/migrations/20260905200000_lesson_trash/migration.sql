-- Корзина уроков («Утро Ширин» §19). Аддитивно: Lesson.deletedAt — отметка
-- мягкого удаления; у живых уроков null. Через 24 часа строку и файлы в
-- хранилище убирает purgeTrashedLessons (course/lessonTrash.ts).
ALTER TABLE "Lesson" ADD COLUMN "deletedAt" DATETIME;
CREATE INDEX "Lesson_deletedAt_idx" ON "Lesson"("deletedAt");
