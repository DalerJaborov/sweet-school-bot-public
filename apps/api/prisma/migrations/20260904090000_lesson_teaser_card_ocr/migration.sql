-- Импорт из канала школы: тизер урока (исходник и готовый mp4 480p) и
-- пометка, что рецепт распознан с фото-карточки и ждёт проверки. Аддитивно:
-- три необязательные колонки, старые строки остаются как есть.
ALTER TABLE "Lesson" ADD COLUMN "teaserPath" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "teaserMp4Path" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "recipeSource" TEXT;
