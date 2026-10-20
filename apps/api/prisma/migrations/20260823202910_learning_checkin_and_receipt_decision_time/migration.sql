-- AlterTable
ALTER TABLE "ReceiptCheck" ADD COLUMN "decidedAt" DATETIME;

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
    CONSTRAINT "Purchase_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Purchase" ("amount", "contactId", "course", "createdAt", "currency", "id", "inviteLink", "joinedAt", "rawAmount", "revokedAt") SELECT "amount", "contactId", "course", "createdAt", "currency", "id", "inviteLink", "joinedAt", "rawAmount", "revokedAt" FROM "Purchase";
DROP TABLE "Purchase";
ALTER TABLE "new_Purchase" RENAME TO "Purchase";
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");
CREATE UNIQUE INDEX "Purchase_contactId_course_key" ON "Purchase"("contactId", "course");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
