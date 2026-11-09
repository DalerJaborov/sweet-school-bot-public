-- AlterTable
ALTER TABLE "ReceiptCheck" ADD COLUMN "ownerAlerts" TEXT;
ALTER TABLE "ReceiptCheck" ADD COLUMN "transactionId" TEXT;
ALTER TABLE "ReceiptCheck" ADD COLUMN "retryAfter" DATETIME;

-- CreateIndex
CREATE INDEX "ReceiptCheck_transactionId_idx" ON "ReceiptCheck"("transactionId");
