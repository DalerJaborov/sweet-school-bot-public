-- DropIndex
DROP INDEX "ReceiptCheck_imageHash_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptCheck_imageHash_key" ON "ReceiptCheck"("imageHash");
