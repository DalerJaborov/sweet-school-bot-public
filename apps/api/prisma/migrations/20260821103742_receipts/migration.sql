-- CreateTable
CREATE TABLE "ReceiptCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "linkSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptCheck_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contact" ("createdAt", "id", "igUserId", "tags", "updatedAt", "username") SELECT "createdAt", "id", "igUserId", "tags", "updatedAt", "username" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_igUserId_key" ON "Contact"("igUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
