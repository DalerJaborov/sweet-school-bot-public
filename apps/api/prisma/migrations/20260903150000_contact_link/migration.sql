-- Одна ссылка на ЧЕЛОВЕКА, а не на покупку (владелец 03.09.2026): купившая оба
-- курса получает одно окно с обоими. Строго аддитивно — таблицы не
-- пересоздаются, существующие строки не трогаются, кроме backfill contactId.
ALTER TABLE "Contact" ADD COLUMN "accessTokenId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "accessIssuedAt" DATETIME;
CREATE UNIQUE INDEX "Contact_accessTokenId_key" ON "Contact"("accessTokenId");

ALTER TABLE "Device" ADD COLUMN "contactId" TEXT;
UPDATE "Device" SET "contactId" = (SELECT "contactId" FROM "Purchase" WHERE "Purchase"."id" = "Device"."purchaseId");
CREATE INDEX "Device_contactId_idx" ON "Device"("contactId");

-- Импорт уроков из экспорта Telegram Desktop и обложки уроков.
ALTER TABLE "Lesson" ADD COLUMN "importedFrom" TEXT;
CREATE UNIQUE INDEX "Lesson_importedFrom_key" ON "Lesson"("importedFrom");
ALTER TABLE "Lesson" ADD COLUMN "posterPath" TEXT;
