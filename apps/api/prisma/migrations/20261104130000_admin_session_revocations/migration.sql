CREATE TABLE "AdminSessionRevocation" (
  "hash" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATETIME NOT NULL
);
CREATE INDEX "AdminSessionRevocation_expiresAt_idx" ON "AdminSessionRevocation"("expiresAt");
