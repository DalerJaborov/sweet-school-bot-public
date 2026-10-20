-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StyleExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientText" TEXT NOT NULL,
    "ownerText" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ledToSale" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "approvedForReuse" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_StyleExample" ("clientText", "createdAt", "enabled", "id", "ledToSale", "ownerText", "source") SELECT "clientText", "createdAt", "enabled", "id", "ledToSale", "ownerText", "source" FROM "StyleExample";
DROP TABLE "StyleExample";
ALTER TABLE "new_StyleExample" RENAME TO "StyleExample";
CREATE UNIQUE INDEX "StyleExample_clientText_ownerText_key" ON "StyleExample"("clientText", "ownerText");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
