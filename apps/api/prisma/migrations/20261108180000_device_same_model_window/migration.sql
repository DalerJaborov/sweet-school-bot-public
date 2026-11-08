-- Two identical phones share a client fingerprint. Since 08.11.2026 a
-- fingerprint identifies "the same phone in another browser" only within a
-- 30-minute window, so a second device with the same fingerprint is a valid row.
-- DropIndex
DROP INDEX IF EXISTS "Device_purchaseId_fingerprint_key";

-- CreateTable
CREATE TABLE "AccessEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "deviceId" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccessEvent_contactId_createdAt_idx" ON "AccessEvent"("contactId", "createdAt");
