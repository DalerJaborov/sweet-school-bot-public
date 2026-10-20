-- CreateTable
CREATE TABLE "QaMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "telegramUserId" TEXT,
    "telegramMsgId" INTEGER,
    "fromOwner" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "QaExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentText" TEXT NOT NULL,
    "ownerText" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "QaMessage_chatId_createdAt_idx" ON "QaMessage"("chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QaExample_studentText_ownerText_key" ON "QaExample"("studentText", "ownerText");
