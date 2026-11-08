-- Additive: nullable column, no backfill needed.
ALTER TABLE "Contact" ADD COLUMN "humanRequestedAt" DATETIME;
