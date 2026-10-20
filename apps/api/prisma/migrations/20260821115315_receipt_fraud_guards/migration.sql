/*
  Warnings:

  - Added the required column `imageHash` to the `ReceiptCheck` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReceiptCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "linkSent" BOOLEAN NOT NULL DEFAULT false,
    "imageHash" TEXT NOT NULL,
    "receiptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptCheck_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ReceiptCheck" ("confidence", "contactId", "createdAt", "id", "kind", "linkSent", "reason") SELECT "confidence", "contactId", "createdAt", "id", "kind", "linkSent", "reason" FROM "ReceiptCheck";
DROP TABLE "ReceiptCheck";
ALTER TABLE "new_ReceiptCheck" RENAME TO "ReceiptCheck";
CREATE INDEX "ReceiptCheck_imageHash_idx" ON "ReceiptCheck"("imageHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
