-- ВНИМАНИЕ ПЕРЕД ПРОДОМ.
--
-- Ниже, в блоке RedefineTables, Prisma ПЕРЕСОЗДАЁТ таблицу Purchase целиком:
-- CREATE new_Purchase -> INSERT SELECT -> DROP Purchase -> RENAME. Это штатное
-- поведение SQLite (нет ALTER TABLE ADD CONSTRAINT), но означает, что во время
-- миграции таблица продаж на короткое время отсутствует.
--
-- Поэтому шаг 1 выполняется ТОЛЬКО так (см. docs/course-platform-design.md, §3):
--   1) sqlite3 /data/bot.db ".backup /data/backup/bot-<дата>-step1.db"
--   2) docker compose stop api      -- вебхуки Meta повторятся сами
--   3) npx prisma migrate deploy
--   4) сверить count(*) по Purchase до и после
--   5) docker compose start api
--
-- Все добавленные колонки Purchase nullable или с default: старый код,
-- который о них не знает, продолжает работать без изменений.

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "coverUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deviceLimit" INTEGER NOT NULL DEFAULT 2,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "Module_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "moduleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "hlsPath" TEXT,
    "sourcePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "durationSec" INTEGER,
    "encryptionKey" TEXT,
    "recipeText" TEXT,
    "recipePhotos" TEXT NOT NULL DEFAULT '[]',
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastIp" TEXT,
    "lastCity" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offlineKeyExpiresAt" DATETIME,
    "blockedAt" DATETIME,
    "blockedReason" TEXT,
    CONSTRAINT "Device_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Progress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Progress_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Progress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CourseChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "lessonId" TEXT,
    "fromStudent" BOOLEAN NOT NULL,
    "text" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "byBot" BOOLEAN NOT NULL DEFAULT false,
    "telegramMsgId" INTEGER,
    "readByOwnerAt" DATETIME,
    "queuedOffline" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseChatMessage_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CourseChatMessage_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "course" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "rawAmount" REAL,
    "currency" TEXT,
    "inviteLink" TEXT,
    "joinedAt" DATETIME,
    "revokedAt" DATETIME,
    "learningCheckInSentAt" DATETIME,
    "startedLearning" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "courseId" TEXT,
    "accessTokenId" TEXT,
    "accessIssuedAt" DATETIME,
    "firstOpenedAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'RECEIPT',
    CONSTRAINT "Purchase_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Purchase_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Purchase" ("amount", "contactId", "course", "createdAt", "currency", "id", "inviteLink", "joinedAt", "learningCheckInSentAt", "rawAmount", "revokedAt", "startedLearning") SELECT "amount", "contactId", "course", "createdAt", "currency", "id", "inviteLink", "joinedAt", "learningCheckInSentAt", "rawAmount", "revokedAt", "startedLearning" FROM "Purchase";
DROP TABLE "Purchase";
ALTER TABLE "new_Purchase" RENAME TO "Purchase";
CREATE UNIQUE INDEX "Purchase_accessTokenId_key" ON "Purchase"("accessTokenId");
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");
CREATE UNIQUE INDEX "Purchase_contactId_course_key" ON "Purchase"("contactId", "course");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Module_courseId_order_key" ON "Module"("courseId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Lesson_moduleId_order_key" ON "Lesson"("moduleId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Device_purchaseId_fingerprint_key" ON "Device"("purchaseId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Progress_purchaseId_lessonId_key" ON "Progress"("purchaseId", "lessonId");

-- CreateIndex
CREATE INDEX "CourseChatMessage_purchaseId_createdAt_idx" ON "CourseChatMessage"("purchaseId", "createdAt");
