-- Реклама Meta: откуда пришёл человек и очередь событий «Покупка» (metaConversions.ts).
ALTER TABLE "Contact" ADD COLUMN "adId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "adSource" TEXT;
ALTER TABLE "Contact" ADD COLUMN "adCtwaClid" TEXT;
ALTER TABLE "Contact" ADD COLUMN "adReferralAt" DATETIME;

CREATE TABLE "MetaConversion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purchaseIds" TEXT NOT NULL,
    "valueTjs" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaConversion_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MetaConversion_eventId_key" ON "MetaConversion"("eventId");
CREATE INDEX "MetaConversion_status_nextAttemptAt_idx" ON "MetaConversion"("status", "nextAttemptAt");
