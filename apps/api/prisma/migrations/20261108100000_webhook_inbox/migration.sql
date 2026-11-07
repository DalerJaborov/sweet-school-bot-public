CREATE TABLE "WebhookInbox" (
 "id" TEXT NOT NULL PRIMARY KEY, "eventKey" TEXT NOT NULL, "payload" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" DATETIME,
 "lastError" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WebhookInbox_eventKey_key" ON "WebhookInbox"("eventKey");
CREATE INDEX "WebhookInbox_state_nextRunAt_idx" ON "WebhookInbox"("state", "nextRunAt");

ALTER TABLE "PendingAiReply" ADD COLUMN "delayNoticeAt" DATETIME;
