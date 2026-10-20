-- Персистентный журнал отказов интеграций — переживает перезапуск контейнера,
-- в отличие от прежнего console.error (см. комментарий у модели ErrorLog).
-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ErrorLog_source_createdAt_idx" ON "ErrorLog"("source", "createdAt");
