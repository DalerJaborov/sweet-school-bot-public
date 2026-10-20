-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL DEFAULT 'INSTAGRAM',
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
INSERT INTO "new_Contact" ("createdAt", "humanSilencedUntil", "id", "igUserId", "paid", "paidAt", "personal", "personalReason", "tags", "updatedAt", "username") SELECT "createdAt", "humanSilencedUntil", "id", "igUserId", "paid", "paidAt", "personal", "personalReason", "tags", "updatedAt", "username" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_channel_igUserId_key" ON "Contact"("channel", "igUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
