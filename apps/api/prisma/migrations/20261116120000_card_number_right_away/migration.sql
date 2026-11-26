-- Номер карты сразу и напоминание «завтра переведу» (16.11.2026).
-- Только аддитивно: новый необязательный столбец и новая таблица, существующие строки не меняются.
-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "stopAfterOrder" INTEGER;

-- CreateTable
CREATE TABLE "PaymentReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentReminder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReminder_triggerMessageId_key" ON "PaymentReminder"("triggerMessageId");

-- CreateIndex
CREATE INDEX "PaymentReminder_contactId_createdAt_idx" ON "PaymentReminder"("contactId", "createdAt");

