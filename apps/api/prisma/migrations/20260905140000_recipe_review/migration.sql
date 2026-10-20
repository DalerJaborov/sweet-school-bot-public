-- Проверка OCR-рецептов владелицей («Утро Ширин» §13). Аддитивно:
-- Lesson.recipeReviewedAt — необязательная отметка «Проверила ✓»; у старых
-- строк null, что для уроков с recipeSource = 'card-ocr' и означает
-- «не проверено».
ALTER TABLE "Lesson" ADD COLUMN "recipeReviewedAt" DATETIME;
