ALTER TABLE "Contact" ADD COLUMN "courseDeliveryChoice" TEXT;
ALTER TABLE "Contact" ADD COLUMN "deliveryChoiceAskedAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "deliveryChoicePromptState" TEXT;
ALTER TABLE "Contact" ADD COLUMN "deliveryChoicePromptMid" TEXT;
ALTER TABLE "Contact" ADD COLUMN "deliveryChoiceDispatchAt" DATETIME;
ALTER TABLE "Purchase" ADD COLUMN "deliveryAwaitingChoice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReceiptCheck" ADD COLUMN "awaitingDeliveryChoice" BOOLEAN NOT NULL DEFAULT false;
