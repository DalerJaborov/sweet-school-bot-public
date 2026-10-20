-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "mid" TEXT,
    "text" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Funnel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "postUrl" TEXT,
    "mediaId" TEXT,
    "keywords" TEXT NOT NULL DEFAULT '[]',
    "anyComment" BOOLEAN NOT NULL DEFAULT false,
    "startTag" TEXT NOT NULL DEFAULT 'kurs_started',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FunnelStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "funnelId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "buttons" TEXT NOT NULL DEFAULT '[]',
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "stopAfter" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FunnelStep_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "funnelId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextOrder" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME,
    "commentId" TEXT,
    "commentText" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Delivery_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Delivery_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeenComment" (
    "commentId" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_igUserId_key" ON "Contact"("igUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_mid_key" ON "Message"("mid");

-- CreateIndex
CREATE UNIQUE INDEX "FunnelStep_funnelId_order_key" ON "FunnelStep"("funnelId", "order");

-- CreateIndex
CREATE INDEX "Delivery_state_nextRunAt_idx" ON "Delivery"("state", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_funnelId_contactId_key" ON "Delivery"("funnelId", "contactId");
