-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "afterHours" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FollowUpSend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followUpId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUpSend_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowUpSend_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpSend_followUpId_contactId_key" ON "FollowUpSend"("followUpId", "contactId");
