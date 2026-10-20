-- Контакт заблокирован ботом за флирт/оскорбления/рекламный спам/видео без текста
-- (владелец 05.09.2026): бот молчит, переписка записывается, снять можно из панели.
ALTER TABLE "Contact" ADD COLUMN "spamBlockedAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "spamReason" TEXT;
