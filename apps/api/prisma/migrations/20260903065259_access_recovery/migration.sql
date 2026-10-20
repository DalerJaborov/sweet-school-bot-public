-- Перевыдача ссылки ботом (Purchase.linkReissueCount/linkReissuedAt) и лимит
-- устройств по умолчанию 3 вместо 2.
--
-- Prisma снова ПЕРЕСОЗДАЁТ таблицы (Course и Purchase) — SQLite не умеет иначе.
-- Бэкап снимается автоматически перед миграцией при старте контейнера
-- (см. Dockerfile CMD и scripts/backup-db.ts), отдельных действий не нужно.
--
-- Существующим курсам deviceLimit НЕ меняется: DEFAULT действует только на
-- новые строки. Поэтому ниже отдельный UPDATE — иначе у уже созданных курсов
-- остался бы старый лимит 2, и правка не дала бы никакого эффекта.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "coverUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deviceLimit" INTEGER NOT NULL DEFAULT 3,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Course" ("active", "code", "coverUrl", "createdAt", "description", "deviceLimit", "id", "order", "price", "title", "updatedAt") SELECT "active", "code", "coverUrl", "createdAt", "description", "deviceLimit", "id", "order", "price", "title", "updatedAt" FROM "Course";
DROP TABLE "Course";
ALTER TABLE "new_Course" RENAME TO "Course";
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");
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
    "linkReissueCount" INTEGER NOT NULL DEFAULT 0,
    "linkReissuedAt" DATETIME,
    CONSTRAINT "Purchase_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Purchase_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Purchase" ("accessIssuedAt", "accessTokenId", "amount", "contactId", "course", "courseId", "createdAt", "currency", "firstOpenedAt", "id", "inviteLink", "joinedAt", "learningCheckInSentAt", "rawAmount", "revokedAt", "source", "startedLearning") SELECT "accessIssuedAt", "accessTokenId", "amount", "contactId", "course", "courseId", "createdAt", "currency", "firstOpenedAt", "id", "inviteLink", "joinedAt", "learningCheckInSentAt", "rawAmount", "revokedAt", "source", "startedLearning" FROM "Purchase";
DROP TABLE "Purchase";
ALTER TABLE "new_Purchase" RENAME TO "Purchase";
CREATE UNIQUE INDEX "Purchase_accessTokenId_key" ON "Purchase"("accessTokenId");
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");
CREATE UNIQUE INDEX "Purchase_contactId_course_key" ON "Purchase"("contactId", "course");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Поднять лимит уже существующим курсам (см. пояснение выше).
UPDATE "Course" SET "deviceLimit" = 3 WHERE "deviceLimit" = 2;
