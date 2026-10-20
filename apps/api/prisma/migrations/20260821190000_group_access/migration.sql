-- Связь клиента с его Telegram-аккаунтом и возможность отобрать доступ.
ALTER TABLE "Contact" ADD COLUMN "inviteLink" TEXT;
ALTER TABLE "Contact" ADD COLUMN "telegramUserId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "joinedGroupAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "accessRevokedAt" DATETIME;
CREATE INDEX "Contact_inviteLink_idx" ON "Contact"("inviteLink");
