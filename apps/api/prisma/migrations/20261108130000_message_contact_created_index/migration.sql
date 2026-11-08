-- Additive and reversible (DROP INDEX): speeds up last-message lookups per contact.
CREATE INDEX IF NOT EXISTS "Message_contactId_createdAt_idx" ON "Message"("contactId", "createdAt");
