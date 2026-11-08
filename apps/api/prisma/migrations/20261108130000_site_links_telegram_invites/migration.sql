-- Раздел «Ссылки» (08.11.2026): короткие ссылки на сайт с меткой источника и
-- приглашения в Telegram-группы из панели. ТОЛЬКО ДОБАВЛЕНИЕ: два nullable
-- столбца (без внешних ключей — SQLite не пересоздаёт таблицы) и две новые
-- таблицы. Существующие строки не меняются.

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "siteLinkId" TEXT;

-- AlterTable
ALTER TABLE "FreeLessonLead" ADD COLUMN "siteLinkId" TEXT;

-- CreateTable
CREATE TABLE "SiteLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "label" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "lastClickAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TelegramInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupKey" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "inviteLink" TEXT NOT NULL,
    "name" TEXT,
    "memberLimit" INTEGER,
    "expiresAt" DATETIME,
    "contactId" TEXT,
    "joinedCount" INTEGER NOT NULL DEFAULT 0,
    "lastJoinedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteLink_code_key" ON "SiteLink"("code");

-- CreateIndex
CREATE INDEX "SiteLink_createdAt_idx" ON "SiteLink"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramInvite_inviteLink_key" ON "TelegramInvite"("inviteLink");

-- CreateIndex
CREATE INDEX "TelegramInvite_createdAt_idx" ON "TelegramInvite"("createdAt");

-- CreateIndex
CREATE INDEX "TelegramInvite_contactId_idx" ON "TelegramInvite"("contactId");

-- CreateIndex
CREATE INDEX "Contact_siteLinkId_idx" ON "Contact"("siteLinkId");

-- CreateIndex
CREATE INDEX "FreeLessonLead_siteLinkId_idx" ON "FreeLessonLead"("siteLinkId");
