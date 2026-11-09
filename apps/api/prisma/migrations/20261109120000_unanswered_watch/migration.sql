-- Сторож «без ответа» (unansweredWatch.ts, владелец 09.11.2026).
-- Только новые необязательные столбцы и индекс: существующие строки не меняются.
ALTER TABLE "Contact" ADD COLUMN "unansweredAlertAt" DATETIME;
ALTER TABLE "SeenComment" ADD COLUMN "contactId" TEXT;
ALTER TABLE "SeenComment" ADD COLUMN "text" TEXT;
ALTER TABLE "SeenComment" ADD COLUMN "outcome" TEXT;
ALTER TABLE "SeenComment" ADD COLUMN "alertedAt" DATETIME;
CREATE INDEX "SeenComment_outcome_createdAt_idx" ON "SeenComment"("outcome", "createdAt");
