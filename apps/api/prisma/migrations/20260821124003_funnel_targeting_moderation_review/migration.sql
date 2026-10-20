/*
  Warnings:

  - You are about to drop the column `mediaId` on the `Funnel` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ReceiptCheck" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "ReceiptCheck" ADD COLUMN "ownerDecision" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" DATETIME,
    "humanSilencedUntil" DATETIME,
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "personalReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contact" ("createdAt", "humanSilencedUntil", "id", "igUserId", "paid", "paidAt", "tags", "updatedAt", "username") SELECT "createdAt", "humanSilencedUntil", "id", "igUserId", "paid", "paidAt", "tags", "updatedAt", "username" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_igUserId_key" ON "Contact"("igUserId");
CREATE TABLE "new_Funnel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "postUrl" TEXT,
    "mediaIds" TEXT NOT NULL DEFAULT '[]',
    "keywords" TEXT NOT NULL DEFAULT '[]',
    "anyComment" BOOLEAN NOT NULL DEFAULT false,
    "startTag" TEXT NOT NULL DEFAULT 'kurs_started',
    "repeatAfterDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Funnel" ("anyComment", "createdAt", "enabled", "id", "keywords", "name", "postUrl", "startTag", "trigger", "updatedAt") SELECT "anyComment", "createdAt", "enabled", "id", "keywords", "name", "postUrl", "startTag", "trigger", "updatedAt" FROM "Funnel";
DROP TABLE "Funnel";
ALTER TABLE "new_Funnel" RENAME TO "Funnel";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
