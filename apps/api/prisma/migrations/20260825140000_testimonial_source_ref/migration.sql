-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Testimonial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastShownAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRef" TEXT
);
INSERT INTO "new_Testimonial" ("active", "caption", "createdAt", "id", "imageUrl", "lastShownAt") SELECT "active", "caption", "createdAt", "id", "imageUrl", "lastShownAt" FROM "Testimonial";
DROP TABLE "Testimonial";
ALTER TABLE "new_Testimonial" RENAME TO "Testimonial";
CREATE UNIQUE INDEX "Testimonial_sourceRef_key" ON "Testimonial"("sourceRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
