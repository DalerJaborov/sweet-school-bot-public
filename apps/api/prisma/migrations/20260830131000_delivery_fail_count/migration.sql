-- Счётчик неудачных попыток отправки текущего шага — растущая пауза вместо
-- немедленного и окончательного FAILED (см. комментарий у модели Delivery).
-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "failCount" INTEGER NOT NULL DEFAULT 0;
