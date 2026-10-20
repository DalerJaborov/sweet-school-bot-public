-- Имя и аватар из профиля Instagram/Messenger.
ALTER TABLE "Contact" ADD COLUMN "name" TEXT;
ALTER TABLE "Contact" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "Contact" ADD COLUMN "profileAt" DATETIME;
