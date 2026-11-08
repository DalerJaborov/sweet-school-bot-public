CREATE TABLE "ReplyGate" (
 "id" TEXT NOT NULL PRIMARY KEY, "contactId" TEXT NOT NULL, "channel" TEXT NOT NULL,
 "cls" TEXT NOT NULL, "action" TEXT NOT NULL, "source" TEXT NOT NULL, "reason" TEXT NOT NULL,
 "preview" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReplyGate_contactId_createdAt_idx" ON "ReplyGate"("contactId", "createdAt");
CREATE INDEX "ReplyGate_createdAt_idx" ON "ReplyGate"("createdAt");
