-- Самообслуживание замены устройства. Аддитивно.
ALTER TABLE "Contact" ADD COLUMN "deviceSwaps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Contact" ADD COLUMN "deviceSwapAt" DATETIME;
-- Лимит устройств: телефон + одно. Браузеры одного телефона — одно устройство.
UPDATE "Course" SET "deviceLimit" = 2 WHERE "deviceLimit" = 3;
