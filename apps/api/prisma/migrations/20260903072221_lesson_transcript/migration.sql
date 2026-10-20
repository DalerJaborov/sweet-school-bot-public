-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "moduleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "hlsPath" TEXT,
    "sourcePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "durationSec" INTEGER,
    "encryptionKey" TEXT,
    "transcript" TEXT,
    "transcriptStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "recipeText" TEXT,
    "recipePhotos" TEXT NOT NULL DEFAULT '[]',
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lesson_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Lesson" ("attachments", "createdAt", "durationSec", "encryptionKey", "hlsPath", "id", "isPreview", "moduleId", "order", "recipePhotos", "recipeText", "sourcePath", "status", "title", "updatedAt") SELECT "attachments", "createdAt", "durationSec", "encryptionKey", "hlsPath", "id", "isPreview", "moduleId", "order", "recipePhotos", "recipeText", "sourcePath", "status", "title", "updatedAt" FROM "Lesson";
DROP TABLE "Lesson";
ALTER TABLE "new_Lesson" RENAME TO "Lesson";
CREATE UNIQUE INDEX "Lesson_moduleId_order_key" ON "Lesson"("moduleId", "order");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
