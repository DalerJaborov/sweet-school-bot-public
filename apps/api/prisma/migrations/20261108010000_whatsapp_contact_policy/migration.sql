ALTER TABLE "Contact" ADD COLUMN "humanTakenOverAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "humanTakeoverMid" TEXT;
ALTER TABLE "Contact" ADD COLUMN "whatsappSavedContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "QaExample" ADD COLUMN "approvedForAnswer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "QaExample" ADD COLUMN "courseId" TEXT;
CREATE TABLE "WhatsAppInbox" (
 "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "chatId" TEXT NOT NULL,
 "contactId" TEXT, "kind" TEXT NOT NULL, "payload" TEXT NOT NULL, "replyToId" TEXT,
 "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "WhatsAppInbox_status_createdAt_idx" ON "WhatsAppInbox"("status", "createdAt");
CREATE INDEX "WhatsAppInbox_chatId_createdAt_idx" ON "WhatsAppInbox"("chatId", "createdAt");
