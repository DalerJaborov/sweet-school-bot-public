-- CreateTable
CREATE TABLE "StyleExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientText" TEXT NOT NULL,
    "ownerText" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ledToSale" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "StyleExample_clientText_ownerText_key" ON "StyleExample"("clientText", "ownerText");
