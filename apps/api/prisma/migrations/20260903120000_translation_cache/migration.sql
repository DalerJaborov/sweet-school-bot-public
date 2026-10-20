-- Кеш переводов для платформы курсов. Строго аддитивно: новая таблица,
-- существующие данные не трогаются.
CREATE TABLE "Translation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Translation_hash_lang_key" ON "Translation"("hash", "lang");
