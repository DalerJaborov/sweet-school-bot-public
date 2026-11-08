-- AlterTable
ALTER TABLE "ReceiptCheck" ADD COLUMN "ownerAlerts" TEXT;
ALTER TABLE "ReceiptCheck" ADD COLUMN "transactionId" TEXT;

-- CreateIndex
CREATE INDEX "ReceiptCheck_transactionId_idx" ON "ReceiptCheck"("transactionId");
