-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_QaExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentText" TEXT NOT NULL,
    "ownerText" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedForReuse" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_QaExample" ("createdAt", "id", "mediaType", "mediaUrl", "ownerText", "studentText") SELECT "createdAt", "id", "mediaType", "mediaUrl", "ownerText", "studentText" FROM "QaExample";
DROP TABLE "QaExample";
ALTER TABLE "new_QaExample" RENAME TO "QaExample";
CREATE UNIQUE INDEX "QaExample_studentText_ownerText_key" ON "QaExample"("studentText", "ownerText");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
