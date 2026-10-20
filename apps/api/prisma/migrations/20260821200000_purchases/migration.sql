-- Покупки по группам: человек может купить один курс, потом второй, или оба сразу.
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "course" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "rawAmount" REAL,
    "currency" TEXT,
    "inviteLink" TEXT,
    "joinedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Purchase_contactId_course_key" ON "Purchase"("contactId", "course");
CREATE INDEX "Purchase_createdAt_idx" ON "Purchase"("createdAt");

-- Чёрный список отпечатков фальшивых чеков.
CREATE TABLE "BlockedReceipt" (
    "imageHash" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Contact" ADD COLUMN "joinReminderAt" DATETIME;
