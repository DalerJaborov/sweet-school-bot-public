-- Обложки урока, сгенерированные автоматически из кадра тизера/постера
-- (storage/coverArt.ts): coverPath — 1280×720 для списков/панели/og:image,
-- storyPath — 1080×1920 для геройского экрана и шаринга в сторис. Аддитивно:
-- две необязательные колонки, старые строки остаются как есть (null, пока не
-- прогнан scripts/backfill-covers.ts).
ALTER TABLE "Lesson" ADD COLUMN "coverPath" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "storyPath" TEXT;
